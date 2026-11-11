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

// Wires of service objects, as in Core and Python: a WireServer on each wire member, a
// WireConnection for each client that connects, and the WireBroadcaster and WireUnicastReceiver
// helpers.

import { RobotRaconteurError } from "robotraconteur";
import type { MemberDefinition, MemberDirection, TimeSpec } from "robotraconteur";
import { DataTypes, getElement, MessageElement, MessageEntry, MessageEntryType, MessageErrorType } from "robotraconteur/internal";
import { EventHook } from "./EventHook.js";
import type { ServerEndpoint } from "./ServerContext.js";
import type { ServiceSkel } from "./ServiceSkel.js";

const TIMESPEC = "RobotRaconteur.TimeSpec";

export function memberError(code: MessageErrorType, name: string, message: string): RobotRaconteurError
{
    return new RobotRaconteurError(code, "RobotRaconteur." + name, message);
}

function valueNotSet(): RobotRaconteurError
{
    return memberError(MessageErrorType.ValueNotSet, "ValueNotSet", "Value not set");
}

function timeNow(): TimeSpec
{
    const now = Date.now();
    return { seconds: BigInt(Math.floor(now / 1000)), nanoseconds: (now % 1000) * 1000000 };
}

function isAfter(a: TimeSpec, b: TimeSpec): boolean
{
    return a.seconds > b.seconds || (a.seconds === b.seconds && a.nanoseconds > b.nanoseconds);
}

export function reportError(what: string, e: unknown): void
{
    console.error(`Error in ${what}:`, e);
}

/** Call a handler set by the service, reporting its errors instead of passing them on */
export function callHandler(what: string, f: () => unknown): void
{
    try
    {
        const r = f() as { catch?: (h: (e: unknown) => void) => void } | undefined;
        r?.catch?.((e) => reportError(what, e));
    }
    catch (e)
    {
        reportError(what, e);
    }
}

/** Resolves waits when a value arrives, or on timeout */
export class Waiters
{
    private waiting = new Set<() => void>();

    wait(timeout: number): Promise<void>
    {
        return new Promise<void>((resolve) =>
        {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const done = () =>
            {
                clearTimeout(timer);
                this.waiting.delete(done);
                resolve();
            };
            this.waiting.add(done);
            if (timeout >= 0) timer = setTimeout(done, timeout);
        });
    }

    notifyAll(): void
    {
        for (const w of [...this.waiting]) w();
    }
}

export function directionOf(m: MemberDefinition): MemberDirection
{
    if (m.modifiers?.includes("readonly")) return "readonly";
    if (m.modifiers?.includes("writeonly")) return "writeonly";
    return "both";
}

/** The wire member of a service object. The node puts one on each wire member, as Python does */
export class WireServer<T = unknown>
{
    /** Called when a client connects */
    wireConnectCallback: ((connection: WireConnection<T>) => unknown) | null = null;
    /** Answers a client's peekInValue, which is the service's out value. Given the client's endpoint */
    peekInValueCallback: ((endpoint: number) => T | Promise<T>) | null = null;
    /** Answers a client's peekOutValue, which is the service's in value */
    peekOutValueCallback: ((endpoint: number) => T | Promise<T>) | null = null;
    /** Receives a client's pokeOutValue */
    pokeOutValueCallback: ((value: T, timestamp: TimeSpec, endpoint: number) => unknown) | null = null;

    /** The direction of the member, as the client sees it */
    readonly direction: MemberDirection;
    private connections = new Map<number, WireConnection<T>>();

    /** @internal */
    constructor(private skel: ServiceSkel, readonly member: MemberDefinition)
    {
        this.direction = directionOf(member);
    }

    get memberName(): string
    {
        return this.member.name;
    }

    /** The open connections, by client endpoint */
    get activeConnections(): WireConnection<T>[]
    {
        return [...this.connections.values()];
    }

    /** @internal */
    packPacket(type: MessageEntryType, value: unknown, time: TimeSpec): MessageEntry
    {
        const e = new MessageEntry(type, this.member.name);
        e.servicePath = this.skel.servicePath;
        e.addElement(MessageElement.nested("packettime", DataTypes.structure_t, TIMESPEC, [
            new MessageElement("seconds", DataTypes.int64_t, BigInt64Array.of(time.seconds)),
            new MessageElement("nanoseconds", DataTypes.int32_t, Int32Array.of(time.nanoseconds))
        ]));
        e.addElement(this.skel.pack("packet", this.member.type!, value));
        return e;
    }

    private unpackPacket(e: MessageEntry): { value: T; timestamp: TimeSpec }
    {
        const ts = getElement(e.elements, "packettime").castNested(DataTypes.structure_t).elements;
        return {
            value: this.skel.unpack(getElement(e.elements, "packet"), this.member.type!) as T,
            timestamp: {
                seconds: (getElement(ts, "seconds").data as BigInt64Array)[0]!,
                nanoseconds: (getElement(ts, "nanoseconds").data as Int32Array)[0]!
            }
        };
    }

    /** @internal Send to a client, which fails if it has disconnected */
    send(e: MessageEntry, endpoint: number): void
    {
        const ep = this.skel.context.getClient(endpoint);
        if (!ep) throw memberError(MessageErrorType.InvalidOperation, "InvalidOperation", "Wire has been disconnected");
        ep.send([e]);
    }

    /** @internal A request from a client for this wire */
    async command(e: MessageEntry, ep: ServerEndpoint): Promise<MessageEntry>
    {
        const endpoint = ep.localEndpoint;
        switch (e.entryType)
        {
        case MessageEntryType.WireConnectReq:
            {
                let c = this.connections.get(endpoint);
                if (!c)
                {
                    // The service's view of the direction is the reverse of the client's
                    const d: MemberDirection = this.direction === "readonly" ? "writeonly" : this.direction === "writeonly" ? "readonly" : "both";
                    c = new WireConnection<T>(this, endpoint, d);
                    this.connections.set(endpoint, c);
                }
                const callback = this.wireConnectCallback;
                if (callback) await callback(c);
                return new MessageEntry(MessageEntryType.WireConnectRet, this.member.name);
            }
        case MessageEntryType.WireDisconnectReq:
            {
                const c = this.connections.get(endpoint);
                if (!c) throw memberError(MessageErrorType.ServiceError, "ServiceError", "Invalid wire connection");
                this.connections.delete(endpoint);
                c.remoteClosed();
                return new MessageEntry(MessageEntryType.WireDisconnectRet, this.member.name);
            }
        case MessageEntryType.WirePeekInValueReq:
            {
                if (this.direction === "writeonly") throw memberError(MessageErrorType.WriteOnlyMember, "WriteOnlyMember", "Write only member");
                const f = this.peekInValueCallback;
                if (!f) throw memberError(MessageErrorType.InvalidOperation, "InvalidOperation", "Invalid operation");
                return this.packPacket(MessageEntryType.WirePeekInValueRet, await f(endpoint), timeNow());
            }
        case MessageEntryType.WirePeekOutValueReq:
            {
                if (this.direction === "readonly") throw memberError(MessageErrorType.ReadOnlyMember, "ReadOnlyMember", "Read only member");
                const f = this.peekOutValueCallback;
                if (!f) throw memberError(MessageErrorType.InvalidOperation, "InvalidOperation", "Invalid operation");
                return this.packPacket(MessageEntryType.WirePeekOutValueRet, await f(endpoint), timeNow());
            }
        case MessageEntryType.WirePokeOutValueReq:
            {
                if (this.direction === "readonly") throw memberError(MessageErrorType.ReadOnlyMember, "ReadOnlyMember", "Read only member");
                const p = this.unpackPacket(e);
                const f = this.pokeOutValueCallback;
                if (!f) throw memberError(MessageErrorType.InvalidOperation, "InvalidOperation", "Invalid operation");
                await f(p.value, p.timestamp, endpoint);
                return new MessageEntry(MessageEntryType.WirePokeOutValueRet, this.member.name);
            }
        default:
            throw memberError(MessageErrorType.InvalidOperation, "InvalidOperation", "Invalid Command");
        }
    }

    /** @internal A value sent by a client on its connection */
    packetReceived(e: MessageEntry, endpoint: number): void
    {
        const c = this.connections.get(endpoint);
        if (!c) return;
        try
        {
            const p = this.unpackPacket(e);
            c.packetReceived(p.value, p.timestamp);
        }
        catch
        {
            // A packet that cannot be unpacked is dropped, as in Core
        }
    }

    /** @internal The connection was closed by the service */
    connectionClosed(c: WireConnection<T>): void
    {
        if (this.connections.get(c.endpoint) === c) this.connections.delete(c.endpoint);
    }

    /** @internal The client disconnected */
    clientDisconnected(endpoint: number): void
    {
        const c = this.connections.get(endpoint);
        if (!c) return;
        this.connections.delete(endpoint);
        c.remoteClosed();
    }

    /** @internal The object is no longer served. Clients are told their connections have closed */
    shutdown(): void
    {
        const all = [...this.connections.values()];
        this.connections.clear();
        for (const c of all)
        {
            this.sendClosed(c.endpoint);
            c.markClosed();
        }
    }

    /** @internal Tell a client its connection has closed */
    sendClosed(endpoint: number): void
    {
        try
        {
            const e = new MessageEntry(MessageEntryType.WireClosed, this.member.name);
            e.servicePath = this.skel.servicePath;
            this.send(e, endpoint);
        }
        catch
        {
            // The client has disconnected
        }
    }
}

/** A client's connection to a wire of a service object */
export class WireConnection<T = unknown>
{
    /** Fired when the client sends a new value, with the connection, value, and timestamp */
    readonly wireValueChanged = new EventHook<[WireConnection<T>, T, TimeSpec]>();
    /** Called when the client closes the connection or disconnects */
    wireConnectionClosedCallback: ((connection: WireConnection<T>) => unknown) | null = null;
    /** Milliseconds a received value stays valid. -1 for always */
    inValueLifespan = -1;
    /** Milliseconds a sent value stays valid. -1 for always */
    outValueLifespan = -1;
    /** Drop values the client sends */
    ignoreInValue = false;
    closed = false;

    private in_value: { value: T; timestamp: TimeSpec } | null = null;
    private in_local = 0;
    private out_value: { value: T; timestamp: TimeSpec } | null = null;
    private out_local = 0;
    private last_send: TimeSpec = { seconds: 0n, nanoseconds: 0 };
    private in_waiters = new Waiters();
    private out_waiters = new Waiters();

    /** @internal */
    constructor(private wire: WireServer<T>, readonly endpoint: number, readonly direction: MemberDirection) {}

    private expired(local: number, lifespan: number): boolean
    {
        return lifespan >= 0 && Date.now() - local > lifespan;
    }

    get inValueValid(): boolean
    {
        return this.in_value !== null && !this.expired(this.in_local, this.inValueLifespan);
    }

    get outValueValid(): boolean
    {
        return this.out_value !== null && !this.expired(this.out_local, this.outValueLifespan);
    }

    /** The timestamp of the last value received, or null */
    get lastValueReceivedTime(): TimeSpec | null
    {
        return this.in_value?.timestamp ?? null;
    }

    /** The timestamp of the last value sent, or null */
    get lastValueSentTime(): TimeSpec | null
    {
        return this.out_value?.timestamp ?? null;
    }

    /** The last value the client sent. Throws ValueNotSet if there is none or it has expired */
    get inValue(): T
    {
        if (this.direction === "writeonly") throw memberError(MessageErrorType.WriteOnlyMember, "WriteOnlyMember", "Write only member");
        if (!this.inValueValid) throw valueNotSet();
        return this.in_value!.value;
    }

    tryGetInValue(): { value: T; timestamp: TimeSpec } | null
    {
        return this.inValueValid ? this.in_value : null;
    }

    /** The last value sent to the client. Throws ValueNotSet if there is none or it has expired */
    get outValue(): T
    {
        if (this.direction === "readonly") throw memberError(MessageErrorType.ReadOnlyMember, "ReadOnlyMember", "Read only member");
        if (!this.outValueValid) throw valueNotSet();
        return this.out_value!.value;
    }

    /** Send a value to the client */
    set outValue(value: T)
    {
        if (this.direction === "readonly") throw memberError(MessageErrorType.ReadOnlyMember, "ReadOnlyMember", "Read only member");
        if (this.closed) throw memberError(MessageErrorType.InvalidOperation, "InvalidOperation", "Wire has been closed");

        // Receivers discard values that are not strictly newer than the last one
        let time = timeNow();
        if (!isAfter(time, this.last_send))
        {
            const n = this.last_send.nanoseconds + 1;
            time = n < 1000000000 ? { seconds: this.last_send.seconds, nanoseconds: n } : { seconds: this.last_send.seconds + 1n, nanoseconds: 0 };
        }
        this.wire.send(this.wire.packPacket(MessageEntryType.WirePacket, value, time), this.endpoint);
        this.last_send = time;
        this.out_value = { value, timestamp: time };
        this.out_local = Date.now();
        this.out_waiters.notifyAll();
    }

    tryGetOutValue(): { value: T; timestamp: TimeSpec } | null
    {
        return this.outValueValid ? this.out_value : null;
    }

    /** Wait until inValue is valid. Returns whether it is valid, as a timeout also ends the wait */
    async waitInValueValid(timeout = -1): Promise<boolean>
    {
        if (!this.inValueValid && !this.closed) await this.in_waiters.wait(timeout);
        return this.inValueValid;
    }

    async waitOutValueValid(timeout = -1): Promise<boolean>
    {
        if (!this.outValueValid && !this.closed) await this.out_waiters.wait(timeout);
        return this.outValueValid;
    }

    /** Close the connection. The client is told it has closed */
    close(): void
    {
        if (this.closed) return;
        this.markClosed();
        this.wire.connectionClosed(this);
        this.wire.sendClosed(this.endpoint);
    }

    /** @internal */
    packetReceived(value: T, timestamp: TimeSpec): void
    {
        if (this.ignoreInValue || this.closed) return;
        // Older values can arrive after newer ones on some transports
        if (this.in_value && !isAfter(timestamp, this.in_value.timestamp)) return;
        this.in_value = { value, timestamp };
        this.in_local = Date.now();
        this.in_waiters.notifyAll();
        callHandler(`wire ${this.wire.memberName} value changed handler`, () => this.wireValueChanged.fire(this, value, timestamp));
    }

    /** @internal */
    markClosed(): void
    {
        this.closed = true;
        this.in_waiters.notifyAll();
        this.out_waiters.notifyAll();
    }

    /** @internal The client closed the connection or disconnected */
    remoteClosed(): void
    {
        if (this.closed) return;
        this.markClosed();
        const f = this.wireConnectionClosedCallback;
        if (f) callHandler(`wire ${this.wire.memberName} closed callback`, () => f(this));
    }
}

/**
 * Sends the same value to every client connected to a wire, as Core's WireBroadcaster. Clients that
 * connect later receive the current value, and peekInValue returns it. Values from clients are
 * ignored.
 */
export class WireBroadcaster<T = unknown>
{
    /** Milliseconds the value stays valid for clients that connect later. -1 for always */
    outValueLifespan = -1;
    /** Chooses the clients that receive values, by endpoint. All clients if null */
    predicate: ((broadcaster: WireBroadcaster<T>, endpoint: number) => boolean) | null = null;

    private out_value: { value: T } | null = null;
    private out_local = 0;
    private connections = new Set<WireConnection<T>>();

    constructor(readonly wire: WireServer<T>)
    {
        if (!(wire instanceof WireServer)) throw memberError(MessageErrorType.InvalidArgument, "InvalidArgument", "Wire must be the WireServer of a service object");
        wire.wireConnectCallback = (c) => this.connected(c);
        wire.peekInValueCallback = () =>
        {
            if (!this.valid) throw valueNotSet();
            return this.out_value!.value;
        };
        wire.peekOutValueCallback = () =>
        {
            throw memberError(MessageErrorType.ReadOnlyMember, "ReadOnlyMember", "Read only wire");
        };
        wire.pokeOutValueCallback = () =>
        {
            throw memberError(MessageErrorType.ReadOnlyMember, "ReadOnlyMember", "Read only wire");
        };
    }

    private get valid(): boolean
    {
        return this.out_value !== null && (this.outValueLifespan < 0 || Date.now() - this.out_local <= this.outValueLifespan);
    }

    private connected(c: WireConnection<T>): void
    {
        c.ignoreInValue = true;
        c.wireConnectionClosedCallback = () => this.connections.delete(c);
        if (this.valid) c.outValue = this.out_value!.value;
        this.connections.add(c);
    }

    /** The number of connected clients */
    get activeWireConnectionCount(): number
    {
        return this.connections.size;
    }

    get outValue(): T
    {
        if (!this.valid) throw valueNotSet();
        return this.out_value!.value;
    }

    /** Send a value to every connected client chosen by the predicate */
    set outValue(value: T)
    {
        this.out_value = { value };
        this.out_local = Date.now();
        for (const c of [...this.connections])
        {
            if (c.closed)
            {
                this.connections.delete(c);
                continue;
            }
            if (this.predicate && !this.predicate(this, c.endpoint)) continue;
            try
            {
                c.outValue = value;
            }
            catch
            {
                this.connections.delete(c);
            }
        }
    }
}

/**
 * Receives values from the most recently connected client of a wire, and from pokeOutValue, as
 * Core's WireUnicastReceiver. A new connection closes the previous one.
 */
export class WireUnicastReceiver<T = unknown>
{
    /** Fired with the value, its timestamp, and the client's endpoint */
    readonly inValueChanged = new EventHook<[T, TimeSpec, number]>();
    /** Milliseconds the value stays valid. -1 for always */
    inValueLifespan = -1;

    private in_value: { value: T; timestamp: TimeSpec; endpoint: number } | null = null;
    private in_local = 0;
    private active: WireConnection<T> | null = null;

    constructor(readonly wire: WireServer<T>)
    {
        if (!(wire instanceof WireServer)) throw memberError(MessageErrorType.InvalidArgument, "InvalidArgument", "Wire must be the WireServer of a service object");
        wire.wireConnectCallback = (c) => this.connected(c);
        wire.peekInValueCallback = () =>
        {
            throw memberError(MessageErrorType.WriteOnlyMember, "WriteOnlyMember", "Write only wire");
        };
        wire.peekOutValueCallback = () =>
        {
            if (!this.in_value) throw valueNotSet();
            return this.in_value.value;
        };
        wire.pokeOutValueCallback = (value, timestamp, endpoint) => this.received(value, timestamp, endpoint);
    }

    private connected(c: WireConnection<T>): void
    {
        if (this.active && this.active !== c) this.active.close();
        this.active = c;
        c.wireConnectionClosedCallback = () =>
        {
            if (this.active === c) this.active = null;
        };
        c.wireValueChanged.addHandler((conn, value, timestamp) => this.received(value, timestamp, conn.endpoint));
    }

    private received(value: T, timestamp: TimeSpec, endpoint: number): void
    {
        this.in_value = { value, timestamp, endpoint };
        this.in_local = Date.now();
        callHandler(`wire ${this.wire.memberName} in value changed handler`, () => this.inValueChanged.fire(value, timestamp, endpoint));
    }

    private get valid(): boolean
    {
        return this.in_value !== null && (this.inValueLifespan < 0 || Date.now() - this.in_local <= this.inValueLifespan);
    }

    /** The last value received. Throws ValueNotSet if there is none or it has expired */
    get inValue(): T
    {
        if (!this.valid) throw valueNotSet();
        return this.in_value!.value;
    }

    /** The last value received with its timestamp and the client's endpoint, or null */
    tryGetInValue(): { value: T; timestamp: TimeSpec; endpoint: number } | null
    {
        return this.valid ? this.in_value : null;
    }
}
