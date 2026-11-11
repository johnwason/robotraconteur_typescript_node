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

export { TcpTransport } from "./transports/TcpTransport.js";
export { DEFAULT_WEBSOCKET_ALLOWED_ORIGINS, isWebSocketOriginAllowed } from "./transports/TcpServer.js";
export { Callback } from "./service/Callback.js";
export { EventHook } from "./service/EventHook.js";
export { PipeBroadcaster, PipeEndpoint, PipeServer } from "./service/Pipe.js";
export { WireBroadcaster, WireConnection, WireServer, WireUnicastReceiver } from "./service/Wire.js";
export { ServerContext, ServerEndpoint } from "./service/ServerContext.js";
export type { ServerServiceListener } from "./service/ServerContext.js";
export type { ServiceObject } from "./service/ServiceSkel.js";
export type { ServerTransportConnection } from "./transports/StreamConnections.js";
import "./service/ServiceHost.js";
export type { TlsClientOptions, WebSocketClientOptions } from "./transports/TcpTransport.js";
export { CertificateError, verifyNodeCertificate } from "./transports/NodeCertificate.js";
export { userConfigDir } from "./transports/NodeDirectories.js";
export type { NodeCertificateOptions } from "./transports/NodeCertificate.js";
export { IPNodeDiscoveryFlags, parseNodeAnnouncement } from "./transports/IPNodeDiscovery.js";
export type { NodeAnnouncement } from "./transports/IPNodeDiscovery.js";
export { NodeDiscovery } from "./discovery/NodeDiscovery.js";
export {
    createServiceSubscriptionFilterAttributeCombinedIdentifier,
    createServiceSubscriptionFilterAttributeIdentifier,
    createServiceSubscriptionFilterAttributeRegex,
    ServiceSubscriptionFilterAttribute,
    ServiceSubscriptionFilterAttributeGroup
} from "./discovery/AttributeFilter.js";
export type { ServiceSubscriptionFilterAttributeGroupOperation } from "./discovery/AttributeFilter.js";
export { ServiceInfo2Subscription } from "./discovery/Subscriptions.js";
export { ServiceSubscriptionManager } from "./discovery/SubscriptionManager.js";
export type { ServiceSubscriptionManagerConnectionMethod, ServiceSubscriptionManagerDetails } from "./discovery/SubscriptionManager.js";
export type { ServiceInfo2Handler, ServiceSubscriptionFilter, ServiceSubscriptionFilterNode } from "./discovery/Subscriptions.js";
export type { NodeDetectedHandler, NodeDiscoveryInfo, NodeDiscoveryOptions, NodeInfo2, NodeLostHandler, ServiceInfo2 } from "./discovery/NodeDiscovery.js";
