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

import { AsyncLocalStorage } from "node:async_hooks";
import { RobotRaconteurError } from "robotraconteur";
import type { Endpoint, NodeID, VarValue, RobotRaconteurNode, ServiceDefinition, TypeDefinition } from "robotraconteur";
import type { ServerTransportConnection } from "../transports/StreamConnections.js";
import { DataTypes, errorToEntry, Message, MessageElement, MessageEntry, MessageEntryType, MessageErrorType, packElement, TypeContext } from "robotraconteur/internal";
import { serviceError, ServiceSkel } from "./ServiceSkel.js";
import type { ServiceObject } from "./ServiceSkel.js";

const VARVALUE_MAP: TypeDefinition = { type: "varvalue", container: "map_string" };
const NO_SCOPE = { name: "" } as ServiceDefinition;

/** Decode an objref index from a service path, the reverse of encodeServicePathIndex */
export function decodeServicePathIndex(index: string): string
{
    try
    {
        return decodeURIComponent(index);
    }
    catch
    {
        throw serviceError(MessageErrorType.ObjectNotFound, "ObjectNotFound", "Invalid service path");
    }
}

/** The segments of a service path, each a name with an optional objref index */
export function parseServicePath(path: string): { name: string; index?: string }[]
{
    return path.split(".").map((s) =>
    {
        const m = /^([a-zA-Z](?:\w*[a-zA-Z0-9])?)(?:\[([a-zA-Z0-9_%]+)\])?$/.exec(s);
        if (!m) throw serviceError(MessageErrorType.ObjectNotFound, "ObjectNotFound", "Invalid service path");
        return m[2] === undefined ? { name: m[1]! } : { name: m[1]!, index: decodeServicePathIndex(m[2]) };
    });
}

export type ServerServiceListener = (context: ServerContext, event: "ClientConnected" | "ClientDisconnected" | "ServiceClosed", endpoint?: number) => void;

/** One connected client of a service */
export class ServerEndpoint implements Endpoint
{
    private static current_storage = new AsyncLocalStorage<ServerEndpoint>();

    /** The client endpoint whose request is being served, if any */
    static get current(): ServerEndpoint | undefined
    {
        return ServerEndpoint.current_storage.getStore();
    }

    localEndpoint = 0;
    lastMessageReceived = Date.now();
    private message_number = 0;
    private request_number = 0;
    private pending = new Map<number, { resolve: (e: MessageEntry) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

    constructor(readonly context: ServerContext, readonly remoteEndpoint: number, readonly remoteNodeID: NodeID, readonly remoteNodeName: string, readonly connection: ServerTransportConnection) {}

    messageReceived(m: Message): void
    {
        this.lastMessageReceived = Date.now();
        const first = m.entries[0];
        if (first?.entryType === MessageEntryType.EndpointCheckCapability)
        {
            const r = new MessageEntry(MessageEntryType.EndpointCheckCapabilityRet, first.memberName);
            r.requestID = first.requestID;
            r.addElement(new MessageElement("return", DataTypes.uint32_t, Uint32Array.of(0)));
            this.trySend([r]);
            return;
        }
        ServerEndpoint.current_storage.run(this, () => void this.context.messageReceived(m, this));
    }

    transportConnectionClosed(): void
    {
        this.context.removeClient(this);
    }

    /** Send entries to the client. Fails if the connection has closed */
    send(entries: MessageEntry[]): void
    {
        const m = new Message();
        m.entries = entries;
        const h = m.header;
        if (entries.some((e) => e.entryType <= 500))
        {
            h.senderNodeName = this.context.node.nodeName;
            h.receiverNodeName = this.remoteNodeName;
        }
        h.senderNodeID = this.context.node.nodeID;
        h.receiverNodeID = this.remoteNodeID;
        h.senderEndpoint = this.localEndpoint;
        h.receiverEndpoint = this.remoteEndpoint;
        h.messageID = this.message_number;
        this.message_number = (this.message_number + 1) & 0xffff;
        this.connection.sendMessage(m);
    }

    /**
     * Send a request to the client and wait for its response, as for a callback. Fails after
     * timeout milliseconds, or when the client disconnects.
     */
    request(e: MessageEntry, timeout = this.context.node.requestTimeout): Promise<MessageEntry>
    {
        this.request_number = (this.request_number % 0xffffffff) + 1;
        const id = this.request_number;
        e.requestID = id;
        return new Promise<MessageEntry>((resolve, reject) =>
        {
            const timer = setTimeout(() =>
            {
                this.pending.delete(id);
                reject(new RobotRaconteurError(MessageErrorType.RequestTimeout, "RobotRaconteur.RequestTimeout", "Request timed out"));
            }, timeout);
            this.pending.set(id, { resolve, reject, timer });
            try
            {
                this.send([e]);
            }
            catch (err)
            {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(err as Error);
            }
        });
    }

    /** A response from the client to a request sent with request() */
    responseReceived(e: MessageEntry): void
    {
        const p = this.pending.get(e.requestID);
        if (!p) return;
        this.pending.delete(e.requestID);
        clearTimeout(p.timer);
        p.resolve(e);
    }

    /** Fail the requests still waiting for the client, which has disconnected */
    failPendingRequests(): void
    {
        const pending = [...this.pending.values()];
        this.pending.clear();
        for (const p of pending)
        {
            clearTimeout(p.timer);
            p.reject(new RobotRaconteurError(MessageErrorType.ConnectionError, "RobotRaconteur.ConnectionError", "Client disconnected"));
        }
    }

    /** Send entries, ignoring a closed connection */
    trySend(entries: MessageEntry[]): void
    {
        try
        {
            this.send(entries);
        }
        catch
        {
            // The client has disconnected
        }
    }
}

/**
 * A service registered with RobotRaconteurNode.registerService. It serves the root object and
 * the objects reached through its objrefs to every connected client.
 */
export class ServerContext
{
    /** Attributes reported to clients, such as for discovery filters. Values must be VarValue */
    readonly attributes = new Map<string, VarValue>();
    readonly types: TypeContext;

    private skels = new Map<string, ServiceSkel>();
    private pending_skels = new Map<string, Promise<ServiceSkel>>();
    private clients = new Map<number, ServerEndpoint>();
    private extra_imports: string[] = [];
    private listeners = new Set<ServerServiceListener>();
    private cleanup_timer: ReturnType<typeof setInterval>;
    private closed = false;

    constructor(readonly node: RobotRaconteurNode, readonly serviceName: string, readonly rootObjectType: string, root: ServiceObject, private on_close: () => void)
    {
        this.types = new TypeContext(node.serviceTypes);
        const skel = new ServiceSkel(this, serviceName, root, rootObjectType);
        this.skels.set(serviceName, skel);
        skel.init();
        this.cleanup_timer = setInterval(() => this.periodicCleanup(), 5000);
        this.cleanup_timer.unref();
    }

    /** The service definition of the root object */
    get serviceDefinition(): ServiceDefinition
    {
        return this.skels.get(this.serviceName)!.def;
    }

    /** Service definitions sent to clients in addition to those the root object imports */
    get extraImports(): string[]
    {
        return [...this.extra_imports];
    }

    addExtraImport(name: string): void
    {
        if (!this.node.serviceTypes.has(name)) throw serviceError(MessageErrorType.ServiceError, "ServiceError", `Service type ${name} is not registered`);
        if (this.extra_imports.includes(name)) throw serviceError(MessageErrorType.InvalidArgument, "InvalidArgument", "Extra import already added");
        this.extra_imports.push(name);
    }

    removeExtraImport(name: string): boolean
    {
        const i = this.extra_imports.indexOf(name);
        if (i < 0) return false;
        this.extra_imports.splice(i, 1);
        return true;
    }

    /** The connected client with a local endpoint number, if any */
    getClient(local_endpoint: number): ServerEndpoint | undefined
    {
        return this.clients.get(local_endpoint);
    }

    /** The local endpoint numbers of the connected clients */
    get clientEndpoints(): number[]
    {
        return [...this.clients.keys()];
    }

    addServerServiceListener(listener: ServerServiceListener): void
    {
        this.listeners.add(listener);
    }

    removeServerServiceListener(listener: ServerServiceListener): void
    {
        this.listeners.delete(listener);
    }

    private notify(event: "ClientConnected" | "ClientDisconnected" | "ServiceClosed", endpoint?: number): void
    {
        for (const l of [...this.listeners])
        {
            try
            {
                l(this, event, endpoint);
            }
            catch (e)
            {
                console.error("Error in server service listener:", e);
            }
        }
    }

    /** Pack the attributes for a client */
    packAttributes(name: string): MessageElement
    {
        return packElement(name, VARVALUE_MAP, this.attributes, NO_SCOPE, this.types);
    }

    /** The object at a service path, asking each objref for its object the first time it is used */
    async getObjectSkel(path: string): Promise<ServiceSkel>
    {
        const existing = this.skels.get(path);
        if (existing) return existing;

        const segments = parseServicePath(path);
        if (segments[0]!.name !== this.serviceName || segments[0]!.index !== undefined) throw serviceError(MessageErrorType.ObjectNotFound, "ObjectNotFound", "Object not found");

        let skel = this.skels.get(this.serviceName)!;
        let current = this.serviceName;
        const parts = path.split(".");
        for (let i = 1; i < segments.length; i++)
        {
            const parent = skel;
            current = current + "." + parts[i]!;
            const known = this.skels.get(current);
            if (known)
            {
                skel = known;
                continue;
            }
            let pending = this.pending_skels.get(current);
            if (!pending)
            {
                const p = current;
                const seg = segments[i]!;
                pending = (async () =>
                {
                    const { obj, type } = await parent.getSubObj(seg.name, seg.index);
                    if (parent.released) throw serviceError(MessageErrorType.ObjectNotFound, "ObjectNotFound", "Object has been released");
                    const s = new ServiceSkel(this, p, obj, type);
                    this.skels.set(p, s);
                    s.init();
                    return s;
                })().finally(() => this.pending_skels.delete(p));
                this.pending_skels.set(current, pending);
            }
            skel = await pending;
        }
        return skel;
    }

    async getObjectType(path: string): Promise<string>
    {
        return (await this.getObjectSkel(path)).objectType;
    }

    /** The object types an object type implements */
    objectImplements(object_type: string): string[]
    {
        const i = object_type.lastIndexOf(".");
        const def = this.node.serviceTypes.get(object_type.substring(0, i));
        return def?.objects.find((o) => o.name === object_type.substring(i + 1))?.implements ?? [];
    }

    async messageReceived(m: Message, ep: ServerEndpoint): Promise<void>
    {
        const ret: MessageEntry[] = [];
        for (const e of m.entries)
        {
            if (e.error === MessageErrorType.InvalidEndpoint)
            {
                this.removeClient(ep);
                return;
            }
            const r = await this.processMessageEntry(e, ep);
            if (r) ret.push(r);
        }
        if (ret.length > 0) ep.trySend(ret);
    }

    private async processMessageEntry(m: MessageEntry, ep: ServerEndpoint): Promise<MessageEntry | null>
    {
        // Responses to requests the service sent, such as callbacks
        if (m.entryType % 2 === 0)
        {
            ep.responseReceived(m);
            return null;
        }

        let ret: MessageEntry | null = null;
        try
        {
            ret = await this.processRequest(m, ep);
        }
        catch (e)
        {
            ret = new MessageEntry((m.entryType + 1) as MessageEntryType, m.memberName);
            errorToEntry(e, ret, this.types);
        }
        if (!ret) return null;
        ret.servicePath = m.servicePath;
        ret.requestID = m.requestID;
        return ret;
    }

    private async processRequest(m: MessageEntry, ep: ServerEndpoint): Promise<MessageEntry | null>
    {
        switch (m.entryType)
        {
        case MessageEntryType.ClientKeepAliveReq:
            return new MessageEntry(MessageEntryType.ClientKeepAliveRet, m.memberName);
        case MessageEntryType.ServiceCheckCapabilityReq:
            {
                const r = new MessageEntry(MessageEntryType.ServiceCheckCapabilityRet, m.memberName);
                r.addElement(new MessageElement("return", DataTypes.uint32_t, Uint32Array.of(0)));
                return r;
            }
        case MessageEntryType.ClientSessionOpReq:
            return this.clientSessionOp(m);
        case MessageEntryType.ObjectTypeName:
            {
                const r = new MessageEntry(MessageEntryType.ObjectTypeNameRet, m.memberName);
                r.addElement(MessageElement.string("objecttype", await this.getObjectType(m.servicePath)));
                return r;
            }
        case MessageEntryType.PropertyGetReq:
            return (await this.getObjectSkel(m.servicePath)).getProperty(m);
        case MessageEntryType.PropertySetReq:
            return (await this.getObjectSkel(m.servicePath)).setProperty(m);
        case MessageEntryType.FunctionCallReq:
            return (await this.getObjectSkel(m.servicePath)).callFunction(m, ep);
        case MessageEntryType.GeneratorNextReq:
            return (await this.getObjectSkel(m.servicePath)).callGeneratorNext(m, ep);
        case MessageEntryType.WireConnectReq:
        case MessageEntryType.WireDisconnectReq:
        case MessageEntryType.WirePeekInValueReq:
        case MessageEntryType.WirePeekOutValueReq:
        case MessageEntryType.WirePokeOutValueReq:
            throw serviceError(MessageErrorType.NotImplementedError, "NotImplementedError", "Wires are not yet supported by robotraconteur-node services");
        case MessageEntryType.PipeConnectReq:
        case MessageEntryType.PipeDisconnectReq:
            throw serviceError(MessageErrorType.NotImplementedError, "NotImplementedError", "Pipes are not yet supported by robotraconteur-node services");
        case MessageEntryType.PipePacket:
        case MessageEntryType.WirePacket:
            return null;
        default:
            throw serviceError(MessageErrorType.ProtocolError, "ProtocolError", "Unknown transaction type");
        }
    }

    private clientSessionOp(m: MessageEntry): MessageEntry
    {
        switch (m.memberName)
        {
        case "AuthenticateUser":
            throw serviceError(MessageErrorType.AuthenticationError, "AuthenticationError", "Authentication not enabled for service");
        case "LogoutUser":
            throw serviceError(MessageErrorType.InvalidOperation, "InvalidOperation", "User is not authenticated");
        default:
            throw serviceError(MessageErrorType.NotImplementedError, "NotImplementedError", `${m.memberName} is not yet supported by robotraconteur-node services`);
        }
    }

    addClient(ep: ServerEndpoint): void
    {
        if (this.closed) throw serviceError(MessageErrorType.ServiceNotFound, "ServiceNotFound", "Service not found");
        this.clients.set(ep.localEndpoint, ep);
        ep.connection.attachEndpoint(ep);
        this.notify("ClientConnected", ep.localEndpoint);
    }

    removeClient(ep: ServerEndpoint): void
    {
        if (!this.clients.delete(ep.localEndpoint)) return;
        ep.failPendingRequests();
        ep.connection.detachEndpoint(ep);
        this.node.deleteEndpoint(ep);
        this.notify("ClientDisconnected", ep.localEndpoint);
    }

    /** Send an entry to every connected client, or to those listed */
    sendEvent(e: MessageEntry, endpoints?: number[]): void
    {
        const targets = endpoints ? endpoints.map((n) => this.clients.get(n)).filter((x) => x !== undefined) : [...this.clients.values()];
        for (const c of targets) c.trySend([e]);
    }

    /**
     * Release an object and the objects below it, so that their objrefs are asked for their objects
     * again, and tell clients to release them. Give the endpoints to tell only some clients, such
     * as when the path contains a key that others should not see.
     */
    releaseServicePath(path: string, endpoints?: number[]): void
    {
        if (path === this.serviceName) throw serviceError(MessageErrorType.ServiceError, "ServiceError", "Root object cannot be released");
        const paths = [...this.skels.keys()].filter((p) => p === path || p.startsWith(path + "."));
        if (paths.length === 0) throw serviceError(MessageErrorType.ServiceError, "ServiceError", "Unknown service path");
        for (const p of paths)
        {
            this.skels.get(p)!.release();
            this.skels.delete(p);
        }
        const e = new MessageEntry(MessageEntryType.ServicePathReleasedReq, "");
        e.servicePath = path;
        this.sendEvent(e, endpoints);
    }

    private periodicCleanup(): void
    {
        const now = Date.now();
        for (const c of [...this.clients.values()])
        {
            if (now - c.lastMessageReceived > this.node.endpointInactivityTimeout) this.removeClient(c);
        }
        const endpoints = new Set(this.clients.keys());
        for (const s of this.skels.values()) s.cleanupGenerators(now, endpoints);
    }

    /** Disconnect the clients and stop serving. Clients are told the service has closed */
    close(): void
    {
        if (this.closed) return;
        this.closed = true;
        clearInterval(this.cleanup_timer);
        const e = new MessageEntry(MessageEntryType.ServiceClosed, "");
        e.servicePath = this.serviceName;
        this.sendEvent(e);
        for (const c of [...this.clients.values()]) this.removeClient(c);
        for (const s of this.skels.values()) s.release();
        this.skels.clear();
        this.notify("ServiceClosed");
        this.on_close();
    }

    get isClosed(): boolean
    {
        return this.closed;
    }
}

