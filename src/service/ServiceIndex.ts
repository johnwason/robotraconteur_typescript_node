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

// The RobotRaconteurServiceIndex service, which clients use to find the services of a node after
// discovering it, as Core's ServiceIndexer.

import { RobotRaconteurError, VarValue } from "robotraconteur";
import type { NodeID, RobotRaconteurNode } from "robotraconteur";
import { MessageErrorType } from "robotraconteur/internal";
import { EventHook } from "./EventHook.js";
import { ServerEndpoint } from "./ServerContext.js";

export const SERVICE_INDEX_NAME = "RobotRaconteurServiceIndex";

/** Core's definition of the service index, which every node serves */
export const SERVICE_INDEX_DEF = `service RobotRaconteurServiceIndex

struct NodeInfo
    field string NodeName
    field uint8[16] NodeID
    field string{int32} ServiceIndexConnectionURL
end struct

struct ServiceInfo
    field string Name
    field string RootObjectType
    field string{int32} RootObjectImplements
    field string{int32} ConnectionURL
    field varvalue{string} Attributes
end struct

object ServiceIndex
    function ServiceInfo{int32} GetLocalNodeServices()
    function NodeInfo{int32} GetRoutedNodes()
    function NodeInfo{int32} GetDetectedNodes()
    event LocalNodeServicesChanged()
end object
`;

/** A node another part of the program has detected, as reported by GetDetectedNodes */
export interface DetectedNode
{
    nodeID: NodeID;
    nodeName: string;
    urls: string[];
}

const detected_sources = new WeakMap<RobotRaconteurNode, () => DetectedNode[]>();

/** @internal Set where GetDetectedNodes gets the nodes the program has detected */
export function setDetectedNodesSource(node: RobotRaconteurNode, source: (() => DetectedNode[]) | null): void
{
    if (source) detected_sources.set(node, source);
    else detected_sources.delete(node);
}

/** The ID without braces, as used in URLs */
export function nodeIDForUrl(id: NodeID): string
{
    return id.toString().replace(/[{}]/g, "");
}

/** Attribute values that discovery reports: strings and numeric arrays, as Core */
function reportedAttribute(v: VarValue): boolean
{
    return typeof v.value === "string" || ArrayBuffer.isView(v.value);
}

/** The service index object. Its members are named as in Core's definition */
export class ServiceIndexImpl
{
    LocalNodeServicesChanged = new EventHook<[]>();

    constructor(private node: RobotRaconteurNode) {}

    GetLocalNodeServices(): Map<number, unknown>
    {
        const url = ServerEndpoint.current?.connection.connectionUrl;
        if (!url)
        {
            throw new RobotRaconteurError(MessageErrorType.ServiceError, "RobotRaconteur.ServiceError", "GetLocalNodeServices must be called through a transport that supports node discovery");
        }
        const id = nodeIDForUrl(this.node.nodeID);
        const out = new Map<number, unknown>();
        for (const name of this.node.registeredServiceNames)
        {
            const c = this.node.getService(name);
            const attributes = new Map([...c.attributes].filter(([, v]) => reportedAttribute(v)));
            out.set(out.size, {
                Name: name,
                RootObjectType: c.rootObjectType,
                RootObjectImplements: new Map(c.objectImplements(c.rootObjectType).map((x, i) => [i, x])),
                ConnectionURL: new Map([[1, `${url}?nodeid=${id}&service=${name}`]]),
                Attributes: attributes
            });
        }
        return out;
    }

    GetRoutedNodes(): Map<number, unknown>
    {
        return new Map();
    }

    GetDetectedNodes(): Map<number, unknown>
    {
        const nodes = detected_sources.get(this.node)?.() ?? [];
        return new Map(nodes.map((n, i) => [i, {
            NodeName: n.nodeName,
            NodeID: Uint8Array.from(n.nodeID.bytes),
            ServiceIndexConnectionURL: new Map(n.urls.map((u, j) => [j, u]))
        }]));
    }
}
