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

// The parts of the Basic Stream Protocol that browsers never use, kept out of the robotraconteur
// package so that it stays small: STARTTLS for clients, and connections accepted by a server.

import { RobotRaconteurError } from "robotraconteur";
import type { Endpoint, ITransportConnection, NodeID } from "robotraconteur";
import {
    connectionError,
    DataTypes,
    errorReturnMessage,
    errorToEntry,
    findElement,
    Message,
    MessageElement,
    MessageEntry,
    MessageEntryType,
    MessageErrorType,
    StreamConnection,
    TransportCapabilityCode
} from "robotraconteur/internal";
import type { SocketAdapter, SocketEvents, SocketOpener, StreamTransportParent } from "robotraconteur/internal";
import { specialRequest } from "../service/ServiceHost.js";

/** The node that answered a STARTTLS request, which its certificate must identify */
export interface TlsPeer
{
    nodeID: NodeID;
    nodeName: string;
    /** True if the server agreed to check a client certificate */
    mutualAuth: boolean;
}

/**
 * Switch the connection to TLS after STARTTLS, and verify the server. Returns the socket to use
 * from then on, which must deliver its data to the same events.
 */
export type TlsStarter = (events: SocketEvents, peer: TlsPeer) => Promise<SocketAdapter>;

export interface StreamTlsOptions
{
    start: TlsStarter;
    /** Ask the server to check a client certificate */
    mutualAuth: boolean;
}

/** A client connection that may switch to TLS with STARTTLS before creating the connection, as Core does */
export class TcpClientConnection extends StreamConnection
{
    /** True once TLS is in use */
    secure = false;

    constructor(parent: StreamTransportParent, target_nodeid: NodeID, target_nodename: string, endpoint: Endpoint, private tls?: StreamTlsOptions)
    {
        super(parent, target_nodeid, target_nodename, endpoint);
    }

    protected override async handshake(events: SocketEvents): Promise<void>
    {
        if (this.tls) await this.startTls(this.tls, events);
        await super.handshake(events);
    }

    /** Ask the server to switch to TLS */
    private async startTls(tls: StreamTlsOptions, events: SocketEvents): Promise<void>
    {
        const m = new Message();
        m.header.senderNodeID = this.parent.node.nodeID;
        m.header.senderNodeName = this.parent.node.nodeName;
        m.header.receiverNodeID = this.target_nodeid;
        m.header.receiverNodeName = this.target_nodename;
        const mm = new MessageEntry(MessageEntryType.StreamOp, "STARTTLS");
        if (tls.mutualAuth) mm.addElement(MessageElement.string("mutualauth", "true"));
        m.entries.push(mm);

        const ret = await this.streamOp(m, "Timed out starting TLS", "Could not start TLS");
        const sender_id = ret.header.senderNodeID;
        const sender_name = ret.header.senderNodeName;
        const any_target = this.target_nodeid.isAnyNode;
        // The same checks as Core, so that the certificate is checked against the node that was requested
        const matches = (any_target && this.target_nodename === "")
            || (!any_target && this.target_nodeid.equals(sender_id))
            || (any_target && sender_name === this.target_nodename);
        if (!matches) throw connectionError("Could not create TLS connection");

        const mutual = findElement(ret.entries[0]!.elements, "mutualauth")?.castString() === "true";
        this.socket = await tls.start(events, { nodeID: sender_id, nodeName: sender_name, mutualAuth: tls.mutualAuth && mutual });
        this.secure = true;
    }
}

/** A transport connection accepted from a client. Several service endpoints may use it */
export interface ServerTransportConnection extends ITransportConnection
{
    /** Notify the endpoint when the connection closes */
    attachEndpoint(e: Endpoint): void;
    detachEndpoint(e: Endpoint): void;
}

/**
 * Whether a message is a request to the node itself rather than to an endpoint, as in Core. These
 * are requests below entry type 500, except ServiceClosed and ObjectTypeName sent to an endpoint.
 */
export function isSpecialRequest(m: Message): boolean
{
    const e = m.entries[0];
    if (!e || e.entryType >= 500 || e.entryType % 2 !== 1) return false;
    if (e.entryType === MessageEntryType.ServiceClosed) return false;
    if (e.entryType === MessageEntryType.ObjectTypeName && m.header.receiverEndpoint !== 0) return false;
    return true;
}

/** A connection accepted by a server, which answers the client's stream operations and requests to the node */
export class ServerStreamConnection extends StreamConnection implements ServerTransportConnection
{
    /** Set once the client has created the connection */
    private created = false;
    private handshake_timer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Serve a socket accepted from a client. The client must create the connection within
     * handshake_timeout milliseconds, or the socket is closed.
     */
    async accept(open: SocketOpener, handshake_timeout: number): Promise<void>
    {
        this.start(await open(this.events()));
        this.handshake_timer = setTimeout(() =>
        {
            if (!this.created) this.close();
        }, handshake_timeout);
        this.handshake_timer.unref?.();
        this.startHeartbeat();
    }

    attachEndpoint(e: Endpoint): void
    {
        this.endpoints.add(e);
    }

    detachEndpoint(e: Endpoint): void
    {
        this.endpoints.delete(e);
    }

    /**
     * Nothing but stream operations is accepted until the client has created the connection, and
     * afterwards only from the node that created it
     */
    protected override rejectMessage(m: Message): boolean
    {
        if (!this.created)
        {
            this.close();
            return true;
        }
        if (!m.header.senderNodeID.equals(this.remoteNodeID))
        {
            this.sendMessage(errorReturnMessage(m, MessageErrorType.NodeNotFound, "RobotRaconteur.NodeNotFound", "Invalid sender node"));
            return true;
        }
        return false;
    }

    protected override routeMessage(m: Message): void
    {
        if (isSpecialRequest(m)) void this.processSpecialRequest(m);
        else super.routeMessage(m);
    }

    private async processSpecialRequest(m: Message): Promise<void>
    {
        try
        {
            const ret = await specialRequest(this.parent.node, m, this);
            if (ret && ret.entries.length > 0 && this.connected) this.sendMessage(ret);
        }
        catch
        {
            this.close();
        }
    }

    /** Answer a stream operation from the client */
    protected override processStreamOp(m: Message): void
    {
        const req = m.entries[0]!;
        const node = this.parent.node;
        const r = new Message();
        r.header.senderNodeID = node.nodeID;
        r.header.senderNodeName = node.nodeName;
        r.header.receiverNodeID = m.header.senderNodeID;
        r.header.receiverNodeName = m.header.senderNodeName;
        const ret = new MessageEntry(MessageEntryType.StreamOpRet, req.memberName);
        r.entries.push(ret);

        try
        {
            switch (req.memberName)
            {
            case "GetRemoteNodeID":
                break;
            case "CreateConnection":
                this.createConnectionForClient(m, ret);
                break;
            case "STARTTLS":
                throw connectionError("This service does not support TLS");
            default:
                throw new RobotRaconteurError(MessageErrorType.ProtocolError, "RobotRaconteur.ProtocolError", "Unknown stream operation");
            }
        }
        catch (e)
        {
            ret.elements = [];
            errorToEntry(e, ret);
        }
        try
        {
            this.sendMessage(r);
        }
        catch
        {
            // The connection has closed
        }
    }

    /** Accept CreateConnection for this node, agreeing on the capabilities both sides support, as Core does */
    private createConnectionForClient(m: Message, ret: MessageEntry): void
    {
        const node = this.parent.node;
        const h = m.header;
        const for_node = h.receiverNodeID.isAnyNode || h.receiverNodeID.equals(node.nodeID);
        if (!for_node || (h.receiverNodeName !== "" && h.receiverNodeName !== node.nodeName))
        {
            throw new RobotRaconteurError(MessageErrorType.NodeNotFound, "RobotRaconteur.NodeNotFound", "Node not found");
        }

        const caps = findElement(m.entries[0]!.elements, "capabilities")?.data;
        if (caps instanceof Uint32Array)
        {
            let message2 = 0;
            for (const cap of caps)
            {
                if (((cap & TransportCapabilityCode.PageMask) >>> 0) === TransportCapabilityCode.Message2BasicPage)
                {
                    message2 = cap & (TransportCapabilityCode.Message2BasicEnable | TransportCapabilityCode.Message2BasicConnectCombined);
                }
            }
            if ((message2 & TransportCapabilityCode.Message2BasicEnable) === 0)
            {
                throw new RobotRaconteurError(MessageErrorType.ProtocolError, "RobotRaconteur.ProtocolError", "Transport must support Message Version 2");
            }
            // Message Version 4 is not offered, so the client continues with Message Version 2
            ret.addElement(new MessageElement("capabilities", DataTypes.uint32_t, Uint32Array.of((message2 | TransportCapabilityCode.Message2BasicPage) >>> 0)));
        }

        this.remoteNodeID = h.senderNodeID;
        this.created = true;
        clearTimeout(this.handshake_timer);
    }

    override close(): void
    {
        clearTimeout(this.handshake_timer);
        super.close();
    }
}
