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

import type { NodeID } from "robotraconteur";
import type { NodeStorage, ServiceInfo2 } from "./NodeDiscovery.js";

/** A node allowed by a filter. Leave nodeID and nodeName unset to match any node */
export interface ServiceSubscriptionFilterNode
{
    nodeID?: NodeID;
    nodeName?: string;
    username?: string;
    credentials?: Map<string, unknown> | Record<string, unknown>;
}

/** Limits which services a subscription uses */
export interface ServiceSubscriptionFilter
{
    /** Allowed nodes, and the credentials to use for them */
    nodes?: ServiceSubscriptionFilterNode[];
    serviceNames?: string[];
    /** Allowed URL schemes, for example "rr+tcp" */
    transportSchemes?: string[];
    /** A custom check, which can examine the service attributes */
    predicate?: (info: ServiceInfo2) => boolean;
    /** The most services to connect to at once */
    maxConnections?: number;
}

/** Receives updates from discovery */
export interface DiscoverySubscriber
{
    nodeUpdated(storage: NodeStorage): void;
    nodeLost(storage: NodeStorage): void;
    close(): void;
}

function nodeMatches(f: ServiceSubscriptionFilterNode, info: ServiceInfo2): boolean
{
    const any_id = !f.nodeID || f.nodeID.isAnyNode;
    const any_name = !f.nodeName;
    return (any_id || f.nodeID!.equals(info.nodeID)) && (any_name || f.nodeName === info.nodeName);
}

/** Check a service against a subscription. Returns the URLs to use, or null if it does not match */
export function filterService(types: string[], filter: ServiceSubscriptionFilter | undefined, storage: NodeStorage, info: ServiceInfo2): { urls: string[]; node?: ServiceSubscriptionFilterNode } | null
{
    if (types.length > 0 && !types.includes(info.rootObjectType) && !info.rootObjectImplements.some((t) => types.includes(t))) return null;
    if (!filter) return { urls: info.connectionURLs };

    let node: ServiceSubscriptionFilterNode | undefined;
    if (filter.nodes && filter.nodes.length > 0)
    {
        node = filter.nodes.find((f) => nodeMatches(f, info));
        if (!node) return null;
    }

    let urls = info.connectionURLs;
    const schemes = filter.transportSchemes;
    if (schemes && schemes.length > 0)
    {
        const matches = (url: string) => schemes.some((s) => url.startsWith(s + "://"));
        urls = info.connectionURLs.filter(matches);
        if (urls.length === 0)
        {
            // The service reported no suitable URL, but the node may have announced one
            urls = storage.info.urls.map((u) => u.url).filter(matches).map((u) => u.replace("RobotRaconteurServiceIndex", info.name));
        }
    }
    if (urls.length === 0) return null;

    if (filter.serviceNames && filter.serviceNames.length > 0 && !filter.serviceNames.includes(info.name)) return null;
    if (filter.predicate && !filter.predicate(info)) return null;

    return { urls, node };
}

export type ServiceInfo2Handler = (subscription: ServiceInfo2Subscription, info: ServiceInfo2) => unknown;

function serviceKey(info: ServiceInfo2): string
{
    return `${info.nodeID.toString()}/${info.name}`;
}

/** Tracks which services exist on the network, without connecting to them */
export class ServiceInfo2Subscription implements DiscoverySubscriber
{
    private services = new Map<string, ServiceInfo2>();
    private detected_listeners = new Set<ServiceInfo2Handler>();
    private lost_listeners = new Set<ServiceInfo2Handler>();
    private closed = false;

    constructor(private types: string[], private filter: ServiceSubscriptionFilter | undefined, private on_close: (s: ServiceInfo2Subscription) => void) {}

    /** The services currently known */
    getDetectedServiceInfo2(): ServiceInfo2[]
    {
        return [...this.services.values()];
    }

    addServiceDetectedListener(listener: ServiceInfo2Handler): void
    {
        this.detected_listeners.add(listener);
    }

    removeServiceDetectedListener(listener: ServiceInfo2Handler): void
    {
        this.detected_listeners.delete(listener);
    }

    addServiceLostListener(listener: ServiceInfo2Handler): void
    {
        this.lost_listeners.add(listener);
    }

    removeServiceLostListener(listener: ServiceInfo2Handler): void
    {
        this.lost_listeners.delete(listener);
    }

    private notify(listeners: Set<ServiceInfo2Handler>, info: ServiceInfo2): void
    {
        for (const l of [...listeners])
        {
            try
            {
                l(this, info);
            }
            catch (e)
            {
                console.error("Error in subscription listener:", e);
            }
        }
    }

    private removeNode(id: NodeID, keep: Set<string>): void
    {
        for (const [key, info] of [...this.services])
        {
            if (info.nodeID.equals(id) && !keep.has(key))
            {
                this.services.delete(key);
                this.notify(this.lost_listeners, info);
            }
        }
    }

    nodeUpdated(storage: NodeStorage): void
    {
        if (this.closed || !storage.services) return;
        const current = new Set<string>();
        for (const info of storage.services)
        {
            if (!filterService(this.types, this.filter, storage, info)) continue;
            const key = serviceKey(info);
            current.add(key);
            const is_new = !this.services.has(key);
            this.services.set(key, info);
            if (is_new) this.notify(this.detected_listeners, info);
        }
        this.removeNode(storage.info.nodeID, current);
    }

    nodeLost(storage: NodeStorage): void
    {
        if (!this.closed) this.removeNode(storage.info.nodeID, new Set());
    }

    close(): void
    {
        if (this.closed) return;
        this.closed = true;
        this.on_close(this);
    }
}
