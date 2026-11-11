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

// Pipes of service objects, as in Core and Python: a PipeServer on each pipe member, a
// PipeEndpoint for each endpoint a client connects, and the PipeBroadcaster helper.

import type { MemberDefinition, MemberDirection } from "robotraconteur";
import { DataTypes, getElement, MessageElement, MessageEntry, MessageEntryType, MessageErrorType } from "robotraconteur/internal";
import { EventHook } from "./EventHook.js";
import type { ServerEndpoint } from "./ServerContext.js";
import type { ServiceSkel } from "./ServiceSkel.js";
import { callHandler, directionOf, memberError, Waiters } from "./Wire.js";

const MAX_PACKET_NUMBER = 0xffffffff;

function nextPacketNumber(n: number): number
{
    return n < MAX_PACKET_NUMBER ? n + 1 : 0;
}

function key(endpoint: number, index: number): string
{
    return `${endpoint}:${index}`;
}

/** The pipe member of a service object. The node puts one on each pipe member, as Python does */
export class PipeServer<T = unknown>
{
    /** Called when a client connects an endpoint */
    pipeConnectCallback: ((endpoint: PipeEndpoint<T>) => unknown) | null = null;

    /** The direction of the member, as the client sees it */
    readonly direction: MemberDirection;
    /** Whether the member allows unreliable endpoints */
    readonly unreliable: boolean;
    private endpoints = new Map<string, PipeEndpoint<T>>();

    /** @internal */
    constructor(private skel: ServiceSkel, readonly member: MemberDefinition)
    {
        this.direction = directionOf(member);
        this.unreliable = member.modifiers?.includes("unreliable") ?? false;
    }

    get memberName(): string
    {
        return this.member.name;
    }

    /** The connected endpoints */
    get activeEndpoints(): PipeEndpoint<T>[]
    {
        return [...this.endpoints.values()];
    }

    /** @internal */
    entry(type: MessageEntryType, unreliable: boolean): MessageEntry
    {
        const e = new MessageEntry(type, this.member.name);
        e.servicePath = this.skel.servicePath;
        if (unreliable) e.metaData = "unreliable\n";
        return e;
    }

    /** @internal */
    pack(v: unknown): MessageElement
    {
        return this.skel.pack("packet", this.member.type!, v);
    }

    /** @internal */
    client(endpoint: number): ServerEndpoint
    {
        const ep = this.skel.context.getClient(endpoint);
        if (!ep) throw memberError(MessageErrorType.InvalidOperation, "InvalidOperation", "Pipe endpoint has been closed");
        return ep;
    }

    /** @internal A connect or disconnect request from a client */
    async command(e: MessageEntry, ep: ServerEndpoint): Promise<MessageEntry>
    {
        const endpoint = ep.localEndpoint;
        const requested = (getElement(e.elements, "index").data as Int32Array)[0]!;
        switch (e.entryType)
        {
        case MessageEntryType.PipeConnectReq:
            {
                // Core's choice of index: past every index this client already uses, or the first
                // free one from 1 if the client did not ask for one
                let index = requested;
                for (const p of this.endpoints.values())
                {
                    if (p.endpoint === endpoint && p.index >= index) index = p.index + 1;
                }
                if (index === -1)
                {
                    index = 1;
                    while (this.endpoints.has(key(endpoint, index))) index++;
                }
                if (this.endpoints.has(key(endpoint, index))) throw memberError(MessageErrorType.InvalidArgument, "InvalidArgument", "Pipe endpoint index in use");

                const ret = new MessageEntry(MessageEntryType.PipeConnectRet, this.member.name);
                ret.addElement(new MessageElement("index", DataTypes.int32_t, Int32Array.of(index)));
                const unreliable_el = e.elements.find((x) => x.elementName === "unreliable");
                const unreliable = this.unreliable && (unreliable_el?.data as Int32Array | undefined)?.[0] === 1;
                if (unreliable) ret.addElement(new MessageElement("unreliable", DataTypes.int32_t, Int32Array.of(1)));

                // The service's view of the direction is the reverse of the client's
                const d: MemberDirection = this.direction === "readonly" ? "writeonly" : this.direction === "writeonly" ? "readonly" : "both";
                const p = new PipeEndpoint<T>(this, index, endpoint, unreliable, d);
                this.endpoints.set(key(endpoint, index), p);
                const callback = this.pipeConnectCallback;
                if (callback) callHandler(`pipe ${this.member.name} connect callback`, () => callback(p));
                return ret;
            }
        case MessageEntryType.PipeDisconnectReq:
            {
                const p = this.endpoints.get(key(endpoint, requested));
                if (!p) throw memberError(MessageErrorType.InvalidArgument, "InvalidArgument", "Invalid pipe");
                this.endpoints.delete(key(endpoint, requested));
                p.remoteClosed();
                return new MessageEntry(MessageEntryType.PipeDisconnectRet, this.member.name);
            }
        default:
            throw memberError(MessageErrorType.InvalidOperation, "InvalidOperation", "Invalid Command");
        }
    }

    /**
     * @internal Packets sent by a client, one element per endpoint index. Packets that ask for it
     * are acknowledged as they arrive, as Core does
     */
    packetReceived(e: MessageEntry, ep: ServerEndpoint): void
    {
        const acks: MessageElement[] = [];
        for (const el of e.elements)
        {
            const index = Number(el.elementName);
            const p = this.endpoints.get(key(ep.localEndpoint, index));
            if (!p) continue;
            try
            {
                const elements = el.castNested().elements;
                const number = (getElement(elements, "packetnumber").data as Uint32Array)[0]!;
                const value = this.skel.unpack(getElement(elements, "packet"), this.member.type!) as T;
                p.packetReceived(value, number);
                if (elements.some((x) => x.elementName === "requestack")) acks.push(new MessageElement(String(index), DataTypes.uint32_t, Uint32Array.of(number)));
            }
            catch (err)
            {
                console.error(`Error receiving packet for pipe ${this.member.name}:`, err);
            }
        }
        if (acks.length === 0) return;
        const r = this.entry(MessageEntryType.PipePacketRet, e.metaData.includes("unreliable"));
        r.elements = acks;
        ep.trySend([r]);
    }

    /** @internal Acknowledgements from a client of packets the service sent */
    ackReceived(e: MessageEntry, ep: ServerEndpoint): void
    {
        for (const el of e.elements)
        {
            this.endpoints.get(key(ep.localEndpoint, Number(el.elementName)))?.ackReceived((el.data as Uint32Array)[0]!);
        }
    }

    /** @internal The endpoint was closed by the service */
    endpointClosed(p: PipeEndpoint<T>): void
    {
        if (this.endpoints.get(key(p.endpoint, p.index)) === p) this.endpoints.delete(key(p.endpoint, p.index));
    }

    /** @internal Tell a client its endpoint has closed */
    sendClosed(p: PipeEndpoint<T>): void
    {
        try
        {
            const e = this.entry(MessageEntryType.PipeClosed, false);
            e.addElement(new MessageElement("index", DataTypes.int32_t, Int32Array.of(p.index)));
            this.client(p.endpoint).send([e]);
        }
        catch
        {
            // The client has disconnected
        }
    }

    /** @internal The client disconnected */
    clientDisconnected(endpoint: number): void
    {
        for (const [k, p] of [...this.endpoints])
        {
            if (p.endpoint !== endpoint) continue;
            this.endpoints.delete(k);
            p.remoteClosed();
        }
    }

    /** @internal The object is no longer served. Clients are told their endpoints have closed */
    shutdown(): void
    {
        const all = [...this.endpoints.values()];
        this.endpoints.clear();
        for (const p of all)
        {
            this.sendClosed(p);
            p.markClosed();
        }
    }
}

/** A pipe endpoint connected by a client */
export class PipeEndpoint<T = unknown>
{
    /** Fired when a packet arrives, with the endpoint */
    readonly packetReceivedEvent = new EventHook<[PipeEndpoint<T>]>();
    /** Fired when the client acknowledges a packet, with the endpoint and packet number */
    readonly packetAckReceivedEvent = new EventHook<[PipeEndpoint<T>, number]>();
    /** Called when the client closes the endpoint or disconnects */
    pipeEndpointClosedCallback: ((endpoint: PipeEndpoint<T>) => unknown) | null = null;
    /** Ask the client to acknowledge each packet sent */
    requestPacketAck = false;
    /** Drop packets the client sends */
    ignoreReceivedPackets = false;
    closed = false;

    private send_number = 0;
    private recv_number = 0;
    private queue: T[] = [];
    private out_of_order = new Map<number, T>();
    private waiters = new Waiters();

    /** @internal */
    constructor(private pipe: PipeServer<T>, readonly index: number, readonly endpoint: number, readonly unreliable: boolean, readonly direction: MemberDirection) {}

    /** The number of packets waiting to be received */
    get available(): number
    {
        return this.queue.length;
    }

    private checkRead(): void
    {
        if (this.direction === "writeonly") throw memberError(MessageErrorType.WriteOnlyMember, "WriteOnlyMember", "Write only pipe");
    }

    private empty(): never
    {
        throw memberError(MessageErrorType.InvalidOperation, "InvalidOperation", "Receive queue empty");
    }

    /**
     * Send a packet and return its packet number. Resolves once the packet has been handed to the
     * network, so awaiting it applies backpressure.
     */
    async sendPacket(value: T): Promise<number>
    {
        if (this.direction === "readonly") throw memberError(MessageErrorType.ReadOnlyMember, "ReadOnlyMember", "Read only pipe");
        if (this.closed) throw memberError(MessageErrorType.InvalidOperation, "InvalidOperation", "Pipe endpoint has been closed");
        const packet = this.pipe.pack(value);
        this.send_number = nextPacketNumber(this.send_number);
        const number = this.send_number;
        const elements = [new MessageElement("packetnumber", DataTypes.uint32_t, Uint32Array.of(number)), packet];
        if (this.requestPacketAck) elements.push(new MessageElement("requestack", DataTypes.uint32_t, Uint32Array.of(1)));
        const e = this.pipe.entry(MessageEntryType.PipePacket, this.unreliable);
        e.addElement(MessageElement.nested(String(this.index), DataTypes.dictionary_t, "", elements));
        await this.pipe.client(this.endpoint).sendWait([e]);
        return number;
    }

    /** Take the next packet. Throws InvalidOperation if there is none */
    receivePacket(): T
    {
        this.checkRead();
        if (this.queue.length === 0) this.empty();
        return this.queue.shift()!;
    }

    /** The next packet, without taking it */
    peekNextPacket(): T
    {
        this.checkRead();
        if (this.queue.length === 0) this.empty();
        return this.queue[0]!;
    }

    /** Take the next packet, waiting up to timeout milliseconds for one. -1 waits indefinitely */
    async receivePacketWait(timeout = -1): Promise<T>
    {
        this.checkRead();
        if (this.queue.length === 0 && !this.closed && timeout !== 0) await this.waiters.wait(timeout);
        return this.receivePacket();
    }

    /** Take the next packet if there is one within the timeout, or return null */
    async tryReceivePacketWait(timeout = -1): Promise<{ value: T } | null>
    {
        this.checkRead();
        if (this.queue.length === 0 && !this.closed && timeout !== 0) await this.waiters.wait(timeout);
        return this.queue.length === 0 ? null : { value: this.queue.shift()! };
    }

    /** Close the endpoint. The client is told it has closed */
    close(): void
    {
        if (this.closed) return;
        this.markClosed();
        this.pipe.endpointClosed(this);
        this.pipe.sendClosed(this);
    }

    /** @internal */
    packetReceived(value: T, number: number): void
    {
        if (this.direction === "writeonly" || this.ignoreReceivedPackets || this.closed) return;
        if (this.unreliable)
        {
            this.queue.push(value);
        }
        else if (number === nextPacketNumber(this.recv_number))
        {
            this.recv_number = number;
            this.queue.push(value);
            for (;;)
            {
                const next = nextPacketNumber(this.recv_number);
                if (!this.out_of_order.has(next)) break;
                this.queue.push(this.out_of_order.get(next)!);
                this.out_of_order.delete(next);
                this.recv_number = next;
            }
        }
        else
        {
            this.out_of_order.set(number, value);
            return;
        }
        this.waiters.notifyAll();
        callHandler(`pipe ${this.pipe.memberName} packet received handler`, () => this.packetReceivedEvent.fire(this));
    }

    /** @internal */
    ackReceived(number: number): void
    {
        callHandler(`pipe ${this.pipe.memberName} packet acknowledgement handler`, () => this.packetAckReceivedEvent.fire(this, number));
    }

    /** @internal */
    markClosed(): void
    {
        this.closed = true;
        this.waiters.notifyAll();
    }

    /** @internal The client closed the endpoint or disconnected */
    remoteClosed(): void
    {
        if (this.closed) return;
        this.markClosed();
        const f = this.pipeEndpointClosedCallback;
        if (f) callHandler(`pipe ${this.pipe.memberName} closed callback`, () => f(this));
    }
}

interface BroadcastEndpoint
{
    endpoint: PipeEndpoint<unknown>;
    /** Packets sent that the client has not acknowledged */
    backlog: Set<number>;
    /** Acknowledgements that arrived before the send finished */
    early_acks: Set<number>;
    active_sends: number;
}

/**
 * Sends each packet to every endpoint connected to a pipe, as Core's PipeBroadcaster. With a
 * maximum backlog, the clients acknowledge packets, and an endpoint with more than that many
 * packets unacknowledged is skipped until it catches up. Packets from clients are ignored.
 */
export class PipeBroadcaster<T = unknown>
{
    /** Chooses the endpoints that receive packets, by client endpoint and index. All if null */
    predicate: ((broadcaster: PipeBroadcaster<T>, endpoint: number, index: number) => boolean) | null = null;

    private endpoints: BroadcastEndpoint[] = [];

    /** maximumBacklog is the number of unacknowledged packets allowed per endpoint. -1 for no limit */
    constructor(readonly pipe: PipeServer<T>, public maxBacklog = -1)
    {
        if (!(pipe instanceof PipeServer)) throw memberError(MessageErrorType.InvalidArgument, "InvalidArgument", "Pipe must be the PipeServer of a service object");
        pipe.pipeConnectCallback = (p) => this.connected(p);
    }

    private connected(p: PipeEndpoint<T>): void
    {
        if (this.maxBacklog !== 0) p.requestPacketAck = true;
        p.ignoreReceivedPackets = true;
        const b: BroadcastEndpoint = { endpoint: p as PipeEndpoint<unknown>, backlog: new Set(), early_acks: new Set(), active_sends: 0 };
        p.packetAckReceivedEvent.addHandler((_e, number) =>
        {
            if (b.backlog.has(number)) b.backlog.delete(number);
            else b.early_acks.add(number);
        });
        p.pipeEndpointClosedCallback = () =>
        {
            this.endpoints = this.endpoints.filter((x) => x !== b);
        };
        this.endpoints.push(b);
    }

    /** The number of connected endpoints */
    get activePipeEndpointCount(): number
    {
        return this.endpoints.length;
    }

    /** Send a packet to every endpoint that is chosen by the predicate and within its backlog */
    async sendPacket(value: T): Promise<void>
    {
        const sends: Promise<void>[] = [];
        for (const b of [...this.endpoints])
        {
            const p = b.endpoint;
            if (p.closed)
            {
                this.endpoints = this.endpoints.filter((x) => x !== b);
                continue;
            }
            if (this.predicate && !this.predicate(this, p.endpoint, p.index)) continue;
            if (this.maxBacklog > -1 && b.backlog.size + b.active_sends > this.maxBacklog) continue;
            b.active_sends++;
            sends.push(p.sendPacket(value).then((number) =>
            {
                if (b.early_acks.has(number)) b.early_acks.delete(number);
                else if (this.maxBacklog !== 0) b.backlog.add(number);
            }, () =>
            {
                this.endpoints = this.endpoints.filter((x) => x !== b);
            }).finally(() => b.active_sends--));
        }
        await Promise.all(sends);
    }
}
