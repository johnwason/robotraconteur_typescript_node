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

import { RobotRaconteurNode } from "robotraconteur";
import type { ServerTransportConnection, ServiceDefinition, TypeDefinition } from "robotraconteur";
import { DataTypes, errorReturnMessage, findElement, Message, MessageElement, MessageEntry, MessageEntryType, MessageErrorType, packElement, TypeContext } from "robotraconteur/internal";
import { ServerContext, ServerEndpoint } from "./ServerContext.js";
import { serviceError } from "./ServiceSkel.js";
import type { ServiceObject } from "./ServiceSkel.js";

declare module "robotraconteur"
{
    interface RobotRaconteurNode
    {
        /**
         * Serve an object to clients as a service. The object's members are used by name as in
         * Python. Registering a name again replaces the service. Added by robotraconteur-node.
         */
        registerService(name: string, objectType: string, obj: ServiceObject): ServerContext;
        /** The service registered with a name. Added by robotraconteur-node */
        getService(name: string): ServerContext;
        /** Stop a service and disconnect its clients. Added by robotraconteur-node */
        closeService(name: string): void;
        /** The names of the registered services. Added by robotraconteur-node */
        readonly registeredServiceNames: string[];
    }
}

const hosts = new WeakMap<RobotRaconteurNode, Map<string, ServerContext>>();

function services(node: RobotRaconteurNode): Map<string, ServerContext>
{
    let s = hosts.get(node);
    if (!s)
    {
        s = new Map();
        hosts.set(node, s);
        node.specialRequestHandler = (m, connection) => specialRequest(node, m, connection);
        node.addShutdownHook(() =>
        {
            for (const c of [...s!.values()]) c.close();
        });
    }
    return s;
}

function findService(node: RobotRaconteurNode, name: string): ServerContext
{
    const c = hosts.get(node)?.get(name);
    if (!c) throw serviceError(MessageErrorType.ServiceNotFound, "ServiceNotFound", "Service not found");
    return c;
}

/** The text of a registered service definition, which is sent to clients */
function definitionText(node: RobotRaconteurNode, name: string): string
{
    const t = node.serviceTypeTexts.get(name);
    if (t === undefined)
    {
        if (node.serviceTypes.has(name)) throw serviceError(MessageErrorType.ServiceError, "ServiceError", `Service type ${name} was not registered from its text`);
        throw serviceError(MessageErrorType.ServiceNotFound, "ServiceNotFound", `Service type ${name} not found`);
    }
    return t;
}

/** The root object's definition, the extra imports, and everything they import */
function serviceDefinitions(node: RobotRaconteurNode, c: ServerContext): string[]
{
    const names: string[] = [c.serviceDefinition.name];
    for (const e of c.extraImports) if (!names.includes(e)) names.push(e);
    for (let i = 0; i < names.length; i++)
    {
        const d = node.serviceTypes.get(names[i]!);
        if (!d) throw serviceError(MessageErrorType.ServiceError, "ServiceError", `Service type ${names[i]} is not registered`);
        for (const imp of d.imports) if (!names.includes(imp)) names.push(imp);
    }
    return names.map((n) => definitionText(node, n));
}

const STRING_LIST: TypeDefinition = { type: "string", container: "list" };
const NO_SCOPE = { name: "" } as ServiceDefinition;
const NO_TYPES = new TypeContext(new Map());

function stringList(name: string, values: string[]): MessageElement
{
    return packElement(name, STRING_LIST, values, NO_SCOPE, NO_TYPES);
}

function setError(r: MessageEntry, code: MessageErrorType, name: string, message: string): void
{
    r.elements = [];
    r.error = code;
    r.addElement(MessageElement.string("errorname", name));
    r.addElement(MessageElement.string("errorstring", message));
}

function connectClient(node: RobotRaconteurNode, c: ServerContext, m: Message, connection: ServerTransportConnection): ServerEndpoint
{
    const ep = new ServerEndpoint(c, m.header.senderEndpoint, m.header.senderNodeID, m.header.senderNodeName, connection);
    node.registerEndpoint(ep);
    try
    {
        c.addClient(ep);
    }
    catch (e)
    {
        node.deleteEndpoint(ep);
        throw e;
    }
    return ep;
}

/** Answer requests to the node itself, as Core's RobotRaconteurNode::SpecialRequest */
async function specialRequest(node: RobotRaconteurNode, m: Message, connection: ServerTransportConnection): Promise<Message | null>
{
    const h = m.header;
    const for_node = (h.receiverNodeID.isAnyNode && (h.receiverNodeName === "" || h.receiverNodeName === node.nodeName)) || h.receiverNodeID.equals(node.nodeID);
    if (!for_node) return errorReturnMessage(m, MessageErrorType.NodeNotFound, "RobotRaconteur.NodeNotFound", "Could not find route to remote node");

    const ret = new Message();
    ret.header.receiverNodeName = h.senderNodeName;
    ret.header.senderNodeName = node.nodeName;
    ret.header.receiverNodeID = h.senderNodeID;
    ret.header.receiverEndpoint = h.senderEndpoint;
    ret.header.senderEndpoint = h.receiverEndpoint;
    ret.header.senderNodeID = node.nodeID;

    for (const e of m.entries)
    {
        const r = new MessageEntry((e.entryType + 1) as MessageEntryType, e.memberName);
        r.requestID = e.requestID;
        r.servicePath = e.servicePath;
        ret.entries.push(r);

        switch (e.entryType)
        {
        case MessageEntryType.GetNodeInfo:
        case MessageEntryType.ConnectionTest:
            break;
        case MessageEntryType.NodeCheckCapability:
            r.addElement(new MessageElement("return", DataTypes.uint32_t, Uint32Array.of(0)));
            break;
        case MessageEntryType.ObjectTypeName:
            try
            {
                const c = findService(node, e.servicePath.split(".")[0]!);
                const type = await c.getObjectType(e.servicePath);
                r.addElement(MessageElement.string("objecttype", type));
                const implemented = c.objectImplements(type);
                if (implemented.length > 0) r.addElement(stringList("objectimplements", implemented));
            }
            catch
            {
                setError(r, MessageErrorType.ObjectNotFound, "RobotRaconteur.ObjectNotFoundException", "Object not found");
            }
            break;
        case MessageEntryType.GetServiceDesc:
            try
            {
                const type = findElement(e.elements, "ServiceType") ?? findElement(e.elements, "servicetype");
                if (type)
                {
                    r.addElement(MessageElement.string("servicedef", definitionText(node, type.castString())));
                }
                else
                {
                    const c = findService(node, e.servicePath);
                    r.addElement(MessageElement.string("servicedef", definitionText(node, c.serviceDefinition.name)));
                    r.addElement(c.packAttributes("attributes"));
                    if (c.extraImports.length > 0) r.addElement(stringList("extraimports", c.extraImports));
                }
            }
            catch
            {
                setError(r, MessageErrorType.ServiceNotFound, "RobotRaconteur.ServiceNotFoundException", "Service not found");
            }
            break;
        case MessageEntryType.ConnectClient:
            try
            {
                const ep = connectClient(node, findService(node, e.servicePath), m, connection);
                ret.header.senderEndpoint = ep.localEndpoint;
            }
            catch
            {
                setError(r, MessageErrorType.ServiceNotFound, "RobotRaconteur.ServiceNotFoundException", "Service not found");
            }
            break;
        case MessageEntryType.DisconnectClient:
            try
            {
                const ep = node.getEndpoint(h.receiverEndpoint);
                const name = findElement(e.elements, "servicename")?.castString();
                if (!(ep instanceof ServerEndpoint) || ep.context.serviceName !== name) throw new Error("Invalid endpoint");
                ep.context.removeClient(ep);
            }
            catch
            {
                setError(r, MessageErrorType.ServiceNotFound, "RobotRaconteur.ServiceNotFoundException", "Service not found");
            }
            break;
        case MessageEntryType.GetServiceAttributes:
            try
            {
                r.addElement(findService(node, e.servicePath.split(".")[0]!).packAttributes("return"));
            }
            catch
            {
                setError(r, MessageErrorType.ServiceError, "RobotRaconteur.ServiceError", "Service not found");
            }
            break;
        case MessageEntryType.ConnectClientCombined:
            await connectClientCombined(node, e, r, m, ret, connection);
            break;
        default:
            setError(r, MessageErrorType.ProtocolError, "RobotRaconteur.ProtocolError", "Invalid Special Operation");
            break;
        }
    }
    return ret;
}

/** Connect a client in one request, returning what it needs to use the service, as Core does */
async function connectClientCombined(node: RobotRaconteurNode, e: MessageEntry, r: MessageEntry, m: Message, ret: Message, connection: ServerTransportConnection): Promise<void>
{
    let c: ServerContext;
    try
    {
        c = findService(node, e.servicePath);
        const type = await c.getObjectType(c.serviceName);
        r.addElement(MessageElement.string("objecttype", type));
        const implemented = c.objectImplements(type);
        if (implemented.length > 0) r.addElement(stringList("objectimplements", implemented));
    }
    catch
    {
        setError(r, MessageErrorType.ServiceNotFound, "RobotRaconteur.ServiceNotFoundException", "Service not found");
        return;
    }

    const return_defs = findElement(e.elements, "returnservicedefs")?.castString().trim().toLowerCase();
    if (return_defs !== "false" && return_defs !== "0")
    {
        try
        {
            r.addElement(stringList("servicedefs", serviceDefinitions(node, c)));
        }
        catch
        {
            setError(r, MessageErrorType.ServiceNotFound, "RobotRaconteur.ServiceNotFoundException", "Service factory configuration error");
            return;
        }
    }

    try
    {
        r.addElement(c.packAttributes("attributes"));
    }
    catch (err)
    {
        console.warn("Could not add attributes to client connect return message:", err);
    }

    if (findElement(e.elements, "username"))
    {
        setError(r, MessageErrorType.AuthenticationError, "RobotRaconteur.AuthenticationError", "Authentication not enabled for service");
        return;
    }

    try
    {
        ret.header.senderEndpoint = connectClient(node, c, m, connection).localEndpoint;
    }
    catch
    {
        setError(r, MessageErrorType.ServiceNotFound, "RobotRaconteur.ServiceNotFoundException", "Service not found");
    }
}

RobotRaconteurNode.prototype.registerService = function (this: RobotRaconteurNode, name: string, objectType: string, obj: ServiceObject): ServerContext
{
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) throw serviceError(MessageErrorType.InvalidArgument, "InvalidArgument", `Invalid service name: ${name}`);
    const s = services(this);
    s.get(name)?.close();
    const c = new ServerContext(this, name, objectType, obj, () =>
    {
        if (s.get(name) === c) s.delete(name);
    });
    s.set(name, c);
    return c;
};

RobotRaconteurNode.prototype.getService = function (this: RobotRaconteurNode, name: string): ServerContext
{
    return findService(this, name);
};

RobotRaconteurNode.prototype.closeService = function (this: RobotRaconteurNode, name: string): void
{
    findService(this, name).close();
};

Object.defineProperty(RobotRaconteurNode.prototype, "registeredServiceNames", {
    get(this: RobotRaconteurNode): string[]
    {
        return [...(hosts.get(this)?.keys() ?? [])];
    }
});
