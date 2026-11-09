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

import { NodeID, parseConnectionUrl, RobotRaconteurError, RobotRaconteurNode, ServiceSubscription } from "robotraconteur";
import { MessageErrorType } from "robotraconteur/internal";
import { IPNodeDiscoveryFlags } from "../transports/IPNodeDiscovery.js";
import type { NodeAnnouncement } from "../transports/IPNodeDiscovery.js";
import type { TcpTransport } from "../transports/TcpTransport.js";
import { filterService, ServiceInfo2Subscription } from "./Subscriptions.js";
import type { DiscoverySubscriber, ServiceSubscriptionFilter } from "./Subscriptions.js";

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
    /** Candidate URLs, which can be passed to connectService */
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
    /** A node is lost when nothing has been heard from it for this long, in milliseconds */
    nodeExpiration?: number;
}

/** What is known about a detected node */
export interface NodeStorage
{
    info: NodeDiscoveryInfo;
    services: ServiceInfo2[] | null;
    last_update_nonce: string;
    updated: boolean;
    updating: boolean;
    retry_window_start: number;
    retry_count: number;
}

export type NodeDetectedHandler = (info: NodeDiscoveryInfo) => void;
export type NodeLostHandler = (info: NodeDiscoveryInfo) => void;

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

function randomInt(low: number, high: number): number
{
    return low + Math.floor(Math.random() * (high - low));
}

function sleepInBackground(ms: number): Promise<void>
{
    return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/** Finds nodes and services on the network. Node.js only, as browsers cannot use UDP */
export class NodeDiscovery
{
    private nodes = new Map<string, NodeStorage>();
    private subscribers = new Set<DiscoverySubscriber>();
    private started = false;
    private detected_listeners = new Set<NodeDetectedHandler>();
    private lost_listeners = new Set<NodeLostHandler>();
    private cleanup_timer: ReturnType<typeof setInterval> | undefined;

    private readonly flags: number;
    private readonly schemes: string[];
    private readonly discovery_wait: number;
    private readonly service_timeout: number;
    private readonly node_expiration: number;

    constructor(private node: RobotRaconteurNode, private transport: TcpTransport, options: NodeDiscoveryOptions = {})
    {
        this.flags = options.flags ?? IPNodeDiscoveryFlags.LinkLocal;
        this.schemes = options.schemes ?? ["rr+tcp"];
        this.discovery_wait = options.discoveryWait ?? 1500;
        this.service_timeout = options.serviceTimeout ?? 5000;
        this.node_expiration = options.nodeExpiration ?? 60000;
    }

    /** Start listening for nodes */
    async start(): Promise<void>
    {
        await this.transport.enableNodeDiscoveryListening((a) => this.nodeAnnounced(a), this.flags);
        this.cleanup_timer = setInterval(() => this.cleanNodes(), Math.min(5000, this.node_expiration));
        this.cleanup_timer.unref();
        this.started = true;
    }

    /** Stop listening and close any subscriptions */
    close(): void
    {
        this.started = false;
        for (const s of [...this.subscribers]) s.close();
        clearInterval(this.cleanup_timer);
        this.transport.disableNodeDiscoveryListening();
    }

    /** The nodes currently known. Their information has not been verified */
    get detectedNodes(): NodeDiscoveryInfo[]
    {
        return [...this.nodes.values()].map((n) => n.info);
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
        const storage = this.nodes.get(key);
        if (!storage)
        {
            if (this.nodes.size >= MAX_NODES) return;
            const added: NodeStorage = {
                info: { nodeID: a.nodeID, nodeName: a.nodeName, urls: [{ url: a.url, lastAnnounceTime: now }], serviceStateNonce: a.serviceStateNonce },
                services: null,
                last_update_nonce: "",
                updated: false,
                updating: false,
                retry_window_start: now,
                retry_count: 0
            };
            this.nodes.set(key, added);
            this.notify(this.detected_listeners, added.info);
            if (this.subscribers.size > 0) void this.updateServiceInfo(added, 0);
            return;
        }

        const info = storage.info;
        info.nodeName = a.nodeName;
        if (a.serviceStateNonce !== "") info.serviceStateNonce = a.serviceStateNonce;
        const existing = info.urls.find((u) => u.url === a.url);
        if (existing) existing.lastAnnounceTime = now;
        else if (info.urls.length < MAX_URLS_PER_NODE) info.urls.push({ url: a.url, lastAnnounceTime: now });

        if (this.subscribers.size > 0 && this.needsUpdate(storage)) this.retryUpdateServiceInfo(storage);
    }

    /** Services can only have changed if the announced nonce changed. Some nodes do not send one */
    private needsUpdate(storage: NodeStorage): boolean
    {
        return storage.info.serviceStateNonce === "" || storage.info.serviceStateNonce !== storage.last_update_nonce;
    }

    private retryUpdateServiceInfo(storage: NodeStorage): void
    {
        if (storage.updating) return;

        const now = Date.now();
        if (now > storage.retry_window_start + 60000)
        {
            storage.retry_window_start = now;
            storage.retry_count = 0;
        }

        const retry = storage.retry_count++;
        let backoff = randomInt(100, 600);
        if (retry > 12) backoff = randomInt(25000, 35000);
        else if (retry > 8) backoff = randomInt(9000, 11000);
        else if (retry > 5) backoff = randomInt(4500, 5500);
        else if (retry > 3) backoff = randomInt(2000, 2500);

        if (storage.info.serviceStateNonce === "" && storage.updated) backoff += 15000;
        void this.updateServiceInfo(storage, backoff);
    }

    private async updateServiceInfo(storage: NodeStorage, backoff: number): Promise<void>
    {
        if (storage.updating) return;
        storage.updating = true;
        const nonce = storage.info.serviceStateNonce;
        let services: ServiceInfo2[];
        try
        {
            // Nodes are often found together, so spread out the connections
            await sleepInBackground(randomInt(100, 600) + backoff);
            services = await this.localNodeServices(storage.info, this.matchingUrls(storage.info, this.schemes));
        }
        catch
        {
            storage.updating = false;
            if (this.subscribers.size > 0 && this.nodes.has(storage.info.nodeID.toString())) this.retryUpdateServiceInfo(storage);
            return;
        }
        storage.updating = false;
        storage.services = services;
        storage.last_update_nonce = nonce;
        storage.updated = true;

        if (storage.info.serviceStateNonce !== nonce)
        {
            // The services changed while this update was running
            void sleepInBackground(5000).then(() =>
            {
                if (this.subscribers.size > 0) this.retryUpdateServiceInfo(storage);
            });
        }
        else
        {
            storage.retry_count = 0;
        }

        for (const s of this.subscribers) s.nodeUpdated(storage);
    }

    private cleanNodes(): void
    {
        const now = Date.now();
        for (const [key, storage] of [...this.nodes])
        {
            storage.info.urls = storage.info.urls.filter((u) => now - u.lastAnnounceTime < this.node_expiration);
            if (storage.info.urls.length === 0)
            {
                this.nodes.delete(key);
                this.notify(this.lost_listeners, storage.info);
                for (const s of this.subscribers) s.nodeLost(storage);
            }
        }
    }

    private addSubscriber(subscriber: DiscoverySubscriber): void
    {
        if (!this.started)
        {
            throw new RobotRaconteurError(MessageErrorType.InvalidOperation, "RobotRaconteur.InvalidOperation", "Call start() before subscribing");
        }
        if (this.subscribers.size === 0) this.transport.setDiscoveryKeepAlive(true);
        this.subscribers.add(subscriber);

        this.transport.sendDiscoveryRequest();
        for (const storage of this.nodes.values())
        {
            if (this.needsUpdate(storage) || !storage.updated) this.retryUpdateServiceInfo(storage);
            subscriber.nodeUpdated(storage);
        }
    }

    private removeSubscriber(subscriber: DiscoverySubscriber): void
    {
        this.subscribers.delete(subscriber);
        if (this.subscribers.size === 0) this.transport.setDiscoveryKeepAlive(false);
    }

    /**
     * Connect to every service of the given types that is found, now or later, and keep them
     * connected. Types are matched against the root object and the types it implements.
     */
    subscribeServiceByType(serviceTypes: string | string[], filter?: ServiceSubscriptionFilter): ServiceSubscription
    {
        const types = typeof serviceTypes === "string" ? [serviceTypes] : serviceTypes;
        const subscription = new ServiceSubscription(this.node, { connectRetryDelay: 15000, connectErrorLimit: 25 });
        const subscriber: DiscoverySubscriber = {
            nodeUpdated: (storage) =>
            {
                for (const service of storage.services ?? [])
                {
                    const match = filterService(types, filter, storage, service);
                    if (!match) continue;
                    subscription.addOrUpdateClient({
                        nodeID: service.nodeID,
                        nodeName: service.nodeName,
                        serviceName: service.name,
                        urls: match.urls,
                        username: match.node?.username,
                        credentials: match.node?.credentials
                    }, filter?.maxConnections || -1);
                }
            },
            nodeLost: () => undefined,
            close: () => subscription.close()
        };
        subscription.addCloseListener(() => this.removeSubscriber(subscriber));
        this.addSubscriber(subscriber);
        return subscription;
    }

    /** Track which services of the given types exist on the network, without connecting to them */
    subscribeServiceInfo2(serviceTypes: string | string[], filter?: ServiceSubscriptionFilter): ServiceInfo2Subscription
    {
        const types = typeof serviceTypes === "string" ? [serviceTypes] : serviceTypes;
        const subscription = new ServiceInfo2Subscription(types, filter, (s) => this.removeSubscriber(s));
        this.addSubscriber(subscription);
        return subscription;
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
        const stub = await withTimeout(this.node.connectService(urls), this.service_timeout, (s) =>
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
        const storage = this.nodes.get(id.toString());
        return storage ? this.nodeInfo(storage.info, schemes) : [];
    }

    async findNodeByName(name: string, schemes = this.schemes): Promise<NodeInfo2[]>
    {
        await this.updateDetectedNodes();
        return this.detectedNodes.filter((n) => n.nodeName === name).flatMap((n) => this.nodeInfo(n, schemes));
    }
}
