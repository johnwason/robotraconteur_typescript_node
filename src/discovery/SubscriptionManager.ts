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

import { RobotRaconteurError, ServiceSubscription } from "robotraconteur";
import type { DecodeOptions } from "robotraconteur";
import { MessageErrorType } from "robotraconteur/internal";
import type { NodeDiscovery, ServiceTypeSource } from "./NodeDiscovery.js";
import type { ServiceSubscriptionFilter } from "./Subscriptions.js";

/** How a managed subscription connects. "default" uses the URLs if there are any, and otherwise the service types */
export type ServiceSubscriptionManagerConnectionMethod = "default" | "url" | "type";

/** Describes one subscription of a ServiceSubscriptionManager */
export interface ServiceSubscriptionManagerDetails
{
    /** Identifies the subscription in the manager */
    name: string;
    /** Connect by URL or by service type. Chosen from what is given if not set */
    connectionMethod?: ServiceSubscriptionManagerConnectionMethod;
    /** The URLs to connect to */
    urls?: string[];
    /** The username for the URLs */
    urlUsername?: string;
    /** The credentials for the URLs */
    urlCredentials?: Map<string, unknown> | Record<string, unknown>;
    /** The service types to find using discovery */
    serviceTypes?: string[];
    /** Limits which discovered services are used */
    filter?: ServiceSubscriptionFilter;
    /** Whether to connect. Defaults to true */
    enabled?: boolean;
    /** How the clients decode received values. The node's decodeOptions if not set */
    decodeOptions?: DecodeOptions;
}

type ConnectionMode = "url" | "type";

interface ManagedSubscription
{
    subscription: ServiceSubscription;
    source: ServiceTypeSource;
    details: ServiceSubscriptionManagerDetails;
    mode: ConnectionMode | null;
}

const URL_RETRY_DELAY = 2500;
const TYPE_RETRY_DELAY = 15000;
const TYPE_ERROR_LIMIT = 25;

function invalidArgument(message: string): RobotRaconteurError
{
    return new RobotRaconteurError(MessageErrorType.InvalidArgument, "RobotRaconteur.InvalidArgument", message);
}

function connectionMode(d: ServiceSubscriptionManagerDetails): ConnectionMode | null
{
    if (d.connectionMethod === "type") return "type";
    if (d.urls!.length > 0) return "url";
    return d.connectionMethod === "default" && d.serviceTypes!.length > 0 ? "type" : null;
}

function normalize(details: ServiceSubscriptionManagerDetails): ServiceSubscriptionManagerDetails
{
    if (!details.name) throw invalidArgument("Subscription name must be specified");
    const connectionMethod = details.connectionMethod ?? "default";
    if (!["default", "url", "type"].includes(connectionMethod)) throw invalidArgument("Invalid connection method");
    const d = { ...details, connectionMethod, urls: [...(details.urls ?? [])], serviceTypes: [...(details.serviceTypes ?? [])] };
    if (connectionMethod === "type" && d.serviceTypes.length === 0) throw invalidArgument("Service types must be specified for connection method type");
    // A subscription with nothing to connect to cannot be enabled
    return { ...d, enabled: (details.enabled ?? true) && connectionMode(d) !== null };
}

/**
 * Keeps a set of named subscriptions, which can be added, removed, enabled, disabled, and changed
 * while running. A name keeps the same ServiceSubscription throughout, so wire and pipe subscriptions
 * made on it continue to work when it is disabled and enabled again.
 */
export class ServiceSubscriptionManager
{
    private subscriptions = new Map<string, ManagedSubscription>();

    /** @param discovery Finds services for subscriptions by type. It must be started before they are used */
    constructor(readonly discovery: NodeDiscovery) {}

    /** Add several subscriptions */
    init(details: ServiceSubscriptionManagerDetails[]): void
    {
        for (const d of details) this.addSubscription(d);
    }

    private create(): Pick<ManagedSubscription, "subscription" | "source" | "mode">
    {
        const subscription = new ServiceSubscription(this.discovery.node, { connectRetryDelay: TYPE_RETRY_DELAY, connectErrorLimit: TYPE_ERROR_LIMIT });
        return { subscription, source: this.discovery.serviceTypeSource(subscription), mode: null };
    }

    private stop(m: ManagedSubscription): void
    {
        if (m.mode === "type") m.source.stop();
        m.subscription.softClose();
        m.mode = null;
    }

    private start(m: ManagedSubscription, mode: ConnectionMode): void
    {
        const d = m.details;
        if (mode === "url")
        {
            m.subscription.connectRetryDelay = URL_RETRY_DELAY;
            m.subscription.initServiceURL(d.urls!, d.urlUsername, d.urlCredentials);
        }
        else
        {
            m.subscription.connectRetryDelay = TYPE_RETRY_DELAY;
            m.source.start(d.serviceTypes!, d.filter);
        }
        m.mode = mode;
    }

    private apply(m: ManagedSubscription, details: ServiceSubscriptionManagerDetails, close: boolean): void
    {
        m.details = details;
        m.subscription.decodeOptions = details.decodeOptions;
        const mode = details.enabled ? connectionMode(details) : null;
        if (mode === null)
        {
            if (m.mode !== null && close) this.stop(m);
            return;
        }

        if (m.mode === mode)
        {
            if (mode === "url") m.subscription.updateServiceURL(details.urls!, details.urlUsername, details.urlCredentials);
            else m.source.update(details.serviceTypes!, details.filter);
            return;
        }

        if (m.mode !== null) this.stop(m);
        this.start(m, mode);
    }

    /** Add a subscription. It is an error if the name is already used */
    addSubscription(details: ServiceSubscriptionManagerDetails): void
    {
        const d = normalize(details);
        if (this.subscriptions.has(d.name)) throw invalidArgument(`Subscription already exists: ${d.name}`);

        const m: ManagedSubscription = { ...this.create(), details: d };
        try
        {
            this.apply(m, d, false);
        }
        catch (e)
        {
            m.subscription.close();
            throw e;
        }
        this.subscriptions.set(d.name, m);
    }

    /**
     * Change how an existing subscription connects, keeping the same ServiceSubscription. A connected
     * client that no longer qualifies is disconnected when changing the types or filter. A change of
     * URLs applies to the next connection.
     */
    updateSubscription(details: ServiceSubscriptionManagerDetails): void
    {
        const d = normalize(details);
        const m = this.subscriptions.get(d.name);
        if (!m) throw invalidArgument(`Subscription not found: ${d.name}`);
        this.apply(m, d, true);
    }

    /** Remove a subscription, closing it unless close is false. An unknown name is ignored */
    removeSubscription(name: string, close = true): void
    {
        const m = this.subscriptions.get(name);
        if (!m) return;
        this.subscriptions.delete(name);
        if (close) m.subscription.close();
    }

    /** Begin connecting a subscription that was disabled. An unknown name is ignored */
    enableSubscription(name: string): void
    {
        const m = this.subscriptions.get(name);
        if (m) this.apply(m, normalize({ ...m.details, enabled: true }), false);
    }

    /** Stop a subscription, disconnecting its clients unless close is false. An unknown name is ignored */
    disableSubscription(name: string, close = true): void
    {
        const m = this.subscriptions.get(name);
        if (m) this.apply(m, { ...m.details, enabled: false }, close);
    }

    /**
     * Get a subscription. An unknown name throws unless forceCreate is true, which adds a disabled
     * subscription to be configured later with updateSubscription.
     */
    getSubscription(name: string, forceCreate = false): ServiceSubscription
    {
        const m = this.subscriptions.get(name);
        if (m) return m.subscription;
        if (!forceCreate) throw invalidArgument(`Subscription not found: ${name}`);

        const details = normalize({ name, connectionMethod: "url", enabled: false });
        const created: ManagedSubscription = { ...this.create(), details };
        this.subscriptions.set(name, created);
        return created.subscription;
    }

    /** Whether a subscription currently has a connected client. An unknown name throws */
    isConnected(name: string): boolean
    {
        return this.getSubscription(name, false).tryGetDefaultClient() !== null;
    }

    /** Whether a subscription is enabled. False for an unknown name */
    isEnabled(name: string): boolean
    {
        return this.subscriptions.get(name)?.details.enabled ?? false;
    }

    /** The names of the subscriptions */
    getSubscriptionNames(): string[]
    {
        return [...this.subscriptions.keys()];
    }

    /** The details of each subscription, as given to addSubscription or updateSubscription */
    getSubscriptionDetails(): ServiceSubscriptionManagerDetails[]
    {
        return [...this.subscriptions.values()].map((m) => ({ ...m.details }));
    }

    /** Remove every subscription, closing them unless closeSubscriptions is false */
    close(closeSubscriptions = true): void
    {
        const all = [...this.subscriptions.values()];
        this.subscriptions.clear();
        if (closeSubscriptions)
        {
            for (const m of all) m.subscription.close();
        }
    }
}
