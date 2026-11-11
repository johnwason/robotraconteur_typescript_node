// Copyright 2011-2026 Wason Technology, LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Object locks and monitor locks of service objects, as in Core.

import { RobotRaconteurError } from "robotraconteur";
import { MessageErrorType } from "robotraconteur/internal";
import type { ServiceSkel } from "./ServiceSkel.js";

/** A monitor lock is released if its client sends nothing to the object for this long, as in Core */
export const MONITOR_LOCK_TIMEOUT = 30000;
/** MonitorEnter and MonitorContinueEnter wait this long before answering "Continue", as in Core */
const MONITOR_ENTER_WAIT = 5000;

export function objectLockedError(message: string): RobotRaconteurError
{
    return new RobotRaconteurError(MessageErrorType.ObjectLockedError, "RobotRaconteur.ObjectLockedError", message);
}

function invalidOperation(message: string): RobotRaconteurError
{
    return new RobotRaconteurError(MessageErrorType.InvalidOperation, "RobotRaconteur.InvalidOperation", message);
}

/**
 * A lock on an object and the objects under it. A user lock lets every client logged in as the
 * user use the objects. A client lock, which has an endpoint, lets only that client use them.
 */
export class ObjectLock
{
    private skels = new Set<ServiceSkel>();

    constructor(readonly username: string, readonly rootPath: string, readonly endpoint = 0) {}

    /** @internal */
    add(skel: ServiceSkel): void
    {
        skel.objectLock = this;
        this.skels.add(skel);
    }

    /** @internal */
    release(): void
    {
        for (const s of this.skels)
        {
            if (s.objectLock === this) s.objectLock = null;
        }
        this.skels.clear();
    }
}

interface MonitorEntry
{
    endpoint: number;
    timeout: number;
    acquired: boolean;
    error: unknown;
    /** Wakes MonitorEnter or MonitorContinueEnter when the lock is acquired or fails */
    wake: (() => void) | null;
    refresh: ReturnType<typeof setTimeout> | undefined;
}

/**
 * The monitor lock of one object, which gives one client at a time the object to itself. Clients
 * waiting for it are served in order. If the object has RobotRaconteurMonitorEnter(timeout) and
 * RobotRaconteurMonitorExit() methods, as in Python, they are called as the lock is acquired and
 * released.
 */
export class Monitor
{
    private holder: MonitorEntry | null = null;
    private entries = new Map<number, MonitorEntry>();
    private queue: MonitorEntry[] = [];

    constructor(private skel: ServiceSkel) {}

    /** The endpoint of the client that holds the lock, or 0 */
    get lockedBy(): number
    {
        return this.holder?.endpoint ?? 0;
    }

    /** Fail for clients other than the one holding the lock. The holder's lock is kept alive */
    check(endpoint: number): void
    {
        if (!this.holder) return;
        if (this.holder.endpoint !== endpoint) throw invalidOperation("Object is currently monitor locked. Use MonitorEnter to obtain monitor lock");
        this.refresh(this.holder);
    }

    async enter(endpoint: number, timeout: number): Promise<string>
    {
        if (this.entries.has(endpoint)) throw invalidOperation("Already acquiring or acquired monitor lock");
        const e: MonitorEntry = { endpoint, timeout, acquired: false, error: null, wake: null, refresh: undefined };
        this.entries.set(endpoint, e);
        this.queue.push(e);
        if (timeout >= 0)
        {
            setTimeout(() =>
            {
                if (e.acquired || e.error) return;
                e.error = new RobotRaconteurError(MessageErrorType.RequestTimeout, "RobotRaconteur.RequestTimeout", "Timed out waiting for monitor lock");
                this.queue = this.queue.filter((x) => x !== e);
                e.wake?.();
            }, timeout).unref?.();
        }
        void this.grant();
        return this.result(e);
    }

    async continueEnter(endpoint: number): Promise<string>
    {
        const e = this.entries.get(endpoint);
        if (!e) throw invalidOperation("Not acquiring monitor lock");
        return this.result(e);
    }

    async exit(endpoint: number): Promise<string | null>
    {
        if (!this.holder) return null;
        const e = this.entries.get(endpoint);
        if (!e || e !== this.holder) throw invalidOperation("Not monitor locked");
        await this.release(e);
        return "OK";
    }

    /** The client disconnected. Its lock is released and it stops waiting */
    clientDisconnected(endpoint: number): void
    {
        const e = this.entries.get(endpoint);
        if (!e) return;
        if (e === this.holder) void this.release(e);
        else this.drop(e);
    }

    private async result(e: MonitorEntry): Promise<string>
    {
        if (!e.acquired && !e.error)
        {
            await new Promise<void>((resolve) =>
            {
                const timer = setTimeout(done, MONITOR_ENTER_WAIT);
                function done(): void
                {
                    clearTimeout(timer);
                    e.wake = null;
                    resolve();
                }
                e.wake = done;
            });
        }
        if (e.error)
        {
            this.drop(e);
            throw e.error;
        }
        return e.acquired ? "OK" : "Continue";
    }

    private drop(e: MonitorEntry): void
    {
        clearTimeout(e.refresh);
        if (this.entries.get(e.endpoint) === e) this.entries.delete(e.endpoint);
        this.queue = this.queue.filter((x) => x !== e);
    }

    private refresh(e: MonitorEntry): void
    {
        clearTimeout(e.refresh);
        e.refresh = setTimeout(() => void this.release(e), MONITOR_LOCK_TIMEOUT);
        e.refresh.unref?.();
    }

    /** Give the lock to the next waiting client */
    private async grant(): Promise<void>
    {
        if (this.holder) return;
        const e = this.queue.shift();
        if (!e) return;
        this.holder = e;
        try
        {
            const obj = this.skel.obj;
            if (typeof obj.RobotRaconteurMonitorEnter === "function") await obj.RobotRaconteurMonitorEnter(e.timeout);
            e.acquired = true;
            this.refresh(e);
        }
        catch (err)
        {
            e.error = err;
            this.holder = null;
            void this.grant();
        }
        e.wake?.();
    }

    private async release(e: MonitorEntry): Promise<void>
    {
        if (this.holder !== e) return;
        this.drop(e);
        this.holder = null;
        try
        {
            const obj = this.skel.obj;
            if (typeof obj.RobotRaconteurMonitorExit === "function") await obj.RobotRaconteurMonitorExit();
        }
        catch (err)
        {
            console.error("Error in RobotRaconteurMonitorExit:", err);
        }
        void this.grant();
    }

    /** The object is no longer served */
    shutdown(): void
    {
        for (const e of this.entries.values())
        {
            clearTimeout(e.refresh);
            e.error ??= invalidOperation("Object has been released");
            e.wake?.();
        }
        this.entries.clear();
        this.queue = [];
        this.holder = null;
    }
}
