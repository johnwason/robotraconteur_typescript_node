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

import { NodeID, parseConnectionUrl, RobotRaconteurNode, ServiceStub } from "robotraconteur";
import { IPNodeDiscoveryFlags } from "../transports/IPNodeDiscovery.js";
import type { NodeAnnouncement } from "../transports/IPNodeDiscovery.js";
import type { TcpTransport } from "../transports/TcpTransport.js";

/** A node seen on the network. The information has not been verified */
export interface NodeDiscoveryInfo
{
    nodeID: NodeID;
    nodeName: string;
    urls: { url: string; lastAnnounceTime: number }[];
    serviceStateNonce: string;
}

/** A node found using discovery */
export interface NodeInfo2
{
    nodeID: NodeID;
    nodeName: string;
    /** Candidate URLs. Add a service parameter to connect to a service */
    connectionURLs: string[];
}

/** A service found using discovery */
export interface ServiceInfo2
{
    name: string;
    rootObjectType: string;
    rootObjectImplements: string[];
    /** Candidate URLs, which can be passed to connectServiceCandidates */
    connectionURLs: string[];
    attributes: Map<string, unknown>;
    nodeID: NodeID;
    nodeName: string;
}

export interface NodeDiscoveryOptions
{
    /** Values of IPNodeDiscoveryFlags. Defaults to IPv6 link-local multicast, as in Core */
    flags?: number;
    /** Transport schemes used when searching for services */
    schemes?: string[];
    /** How long to wait for nodes to respond to a discovery request, in milliseconds */
    discoveryWait?: number;
    /** Limit for interrogating one node for its services, in milliseconds */
    serviceTimeout?: number;
}

export type NodeDetectedHandler = (info: NodeDiscoveryInfo) => void;
export type NodeLostHandler = (info: NodeDiscoveryInfo) => void;

const NODE_EXPIRATION_MS = 60000;
const MAX_NODES = 1000;
const MAX_URLS_PER_NODE = 256;

/** Keep only the transport address of a URL, removing any service parameter */
function shortUrl(url: string, id: NodeID): string
{
    const u = parseConnectionUrl(url);
    const port = u.port === -1 ? "" : `:${u.port}`;
    return `${u.scheme}://${u.host}${port}${u.path}?nodeid=${id.toString().replace(/[{}]/g, "")}`;
}

function values<T>(m: unknown): T[]
{
    return m instanceof Map ? [...(m as Map<unknown, T>).values()] : [];
}

function sleep(ms: number): Promise<void>
{
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, on_late: (v: T) => void): Promise<T>
{
    let done = false;
    return new Promise<T>((resolve, reject) =>
    {
        const timer = setTimeout(() =>
        {
            done = true;
            reject(new Error("Timed out"));
        }, ms);
        p.then((v) =>
        {
            clearTimeout(timer);
            if (done) on_late(v);
            else resolve(v);
        }, (e) =>
        {
            clearTimeout(timer);
            reject(e);
        });
    });
}

/**
 * Connect using several candidate URLs for one service, keeping the first that succeeds. Discovery
 * reports one URL for each network path to a node, and not all of them work from here.
 */
export async function connectServiceCandidates(node: RobotRaconteurNode, urls: string[], username?: string, credentials?: Map<string, unknown> | Record<string, unknown>, objectType?: string): Promise<ServiceStub>
{
    let winner: ServiceStub | undefined;
    const attempts = urls.map(async (url) =>
    {
        const stub = await node.connectService(url, username, credentials, objectType);
        if (winner)
        {
            void node.disconnectService(stub).catch(() => undefined);
            throw new Error("Another connection was made first");
        }
        winner = stub;
        return stub;
    });
    try
    {
        return await Promise.any(attempts);
    }
    catch (e)
    {
        throw (e as AggregateError).errors?.[0] ?? e;
    }
}

/** Finds nodes and services on the network. Node.js only, as browsers cannot use UDP */
export class NodeDiscovery
{
    private nodes = new Map<string, NodeDiscoveryInfo>();
    private detected_listeners = new Set<NodeDetectedHandler>();
    private lost_listeners = new Set<NodeLostHandler>();
    private cleanup_timer: ReturnType<typeof setInterval> | undefined;

    private readonly flags: number;
    private readonly schemes: string[];
    private readonly discovery_wait: number;
    private readonly service_timeout: number;

    constructor(private node: RobotRaconteurNode, private transport: TcpTransport, options: NodeDiscoveryOptions = {})
    {
        this.flags = options.flags ?? IPNodeDiscoveryFlags.LinkLocal;
        this.schemes = options.schemes ?? ["rr+tcp"];
        this.discovery_wait = options.discoveryWait ?? 1500;
        this.service_timeout = options.serviceTimeout ?? 5000;
    }

    /** Start listening for nodes */
    async start(): Promise<void>
    {
        await this.transport.enableNodeDiscoveryListening((a) => this.nodeAnnounced(a), this.flags);
        this.cleanup_timer = setInterval(() => this.cleanNodes(), 5000);
        this.cleanup_timer.unref();
    }

    close(): void
    {
        clearInterval(this.cleanup_timer);
        this.transport.disableNodeDiscoveryListening();
    }

    /** The nodes currently known. Their information has not been verified */
    get detectedNodes(): NodeDiscoveryInfo[]
    {
        return [...this.nodes.values()];
    }

    addNodeDetectedListener(handler: NodeDetectedHandler): void
    {
        this.detected_listeners.add(handler);
    }

    removeNodeDetectedListener(handler: NodeDetectedHandler): void
    {
        this.detected_listeners.delete(handler);
    }

    addNodeLostListener(handler: NodeLostHandler): void
    {
        this.lost_listeners.add(handler);
    }

    removeNodeLostListener(handler: NodeLostHandler): void
    {
        this.lost_listeners.delete(handler);
    }

    private notify<T>(listeners: Set<(x: T) => void>, value: T): void
    {
        for (const l of listeners)
        {
            try
            {
                l(value);
            }
            catch (e)
            {
                console.error("Error in discovery listener:", e);
            }
        }
    }

    private nodeAnnounced(a: NodeAnnouncement): void
    {
        const key = a.nodeID.toString();
        const now = Date.now();
        let info = this.nodes.get(key);
        if (!info)
        {
            if (this.nodes.size >= MAX_NODES) return;
            info = { nodeID: a.nodeID, nodeName: a.nodeName, urls: [{ url: a.url, lastAnnounceTime: now }], serviceStateNonce: a.serviceStateNonce };
            this.nodes.set(key, info);
            this.notify(this.detected_listeners, info);
            return;
        }

        info.nodeName = a.nodeName;
        if (a.serviceStateNonce !== "") info.serviceStateNonce = a.serviceStateNonce;
        const existing = info.urls.find((u) => u.url === a.url);
        if (existing) existing.lastAnnounceTime = now;
        else if (info.urls.length < MAX_URLS_PER_NODE) info.urls.push({ url: a.url, lastAnnounceTime: now });
    }

    private cleanNodes(): void
    {
        const now = Date.now();
        for (const [key, info] of [...this.nodes])
        {
            info.urls = info.urls.filter((u) => now - u.lastAnnounceTime < NODE_EXPIRATION_MS);
            if (info.urls.length === 0)
            {
                this.nodes.delete(key);
                this.notify(this.lost_listeners, info);
            }
        }
    }

    /** Ask nodes to announce themselves and wait for the responses */
    async updateDetectedNodes(): Promise<void>
    {
        this.transport.sendDiscoveryRequest();
        await sleep(this.discovery_wait);
    }

    private matchingUrls(info: NodeDiscoveryInfo, schemes: string[]): string[]
    {
        return info.urls.map((u) => u.url).filter((u) => schemes.includes(parseConnectionUrl(u).scheme));
    }

    private async localNodeServices(info: NodeDiscoveryInfo, urls: string[]): Promise<ServiceInfo2[]>
    {
        const stub = await withTimeout(connectServiceCandidates(this.node, urls), this.service_timeout, (s) =>
        {
            void this.node.disconnectService(s).catch(() => undefined);
        });
        try
        {
            const list = await withTimeout(stub.callFunction("GetLocalNodeServices", []) as Promise<unknown>, this.service_timeout, () => undefined);
            const context = stub.context;
            return values<Record<string, unknown>>(list).map((s) => ({
                name: s["Name"] as string,
                rootObjectType: s["RootObjectType"] as string,
                rootObjectImplements: values<string>(s["RootObjectImplements"]),
                connectionURLs: values<string>(s["ConnectionURL"]),
                attributes: (s["Attributes"] as Map<string, unknown> | null) ?? new Map<string, unknown>(),
                nodeID: context.remoteNodeID,
                nodeName: context.remoteNodeName || info.nodeName
            }));
        }
        finally
        {
            await this.node.disconnectService(stub).catch(() => undefined);
        }
    }

    /** Find services whose root object has or implements the given fully qualified type */
    async findServiceByType(serviceType: string, schemes = this.schemes): Promise<ServiceInfo2[]>
    {
        await this.updateDetectedNodes();

        const results = await Promise.allSettled(this.detectedNodes.flatMap((info) =>
        {
            const urls = this.matchingUrls(info, schemes);
            return urls.length > 0 ? [this.localNodeServices(info, urls)] : [];
        }));

        return results
            .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
            .filter((s) => s.rootObjectType === serviceType || s.rootObjectImplements.includes(serviceType));
    }

    private nodeInfo(info: NodeDiscoveryInfo, schemes: string[]): NodeInfo2[]
    {
        const urls = this.matchingUrls(info, schemes).map((u) => shortUrl(u, info.nodeID));
        return urls.length > 0 ? [{ nodeID: info.nodeID, nodeName: info.nodeName, connectionURLs: urls }] : [];
    }

    async findNodeByID(id: NodeID, schemes = this.schemes): Promise<NodeInfo2[]>
    {
        await this.updateDetectedNodes();
        const info = this.nodes.get(id.toString());
        return info ? this.nodeInfo(info, schemes) : [];
    }

    async findNodeByName(name: string, schemes = this.schemes): Promise<NodeInfo2[]>
    {
        await this.updateDetectedNodes();
        return this.detectedNodes.filter((n) => n.nodeName === name).flatMap((n) => this.nodeInfo(n, schemes));
    }
}
