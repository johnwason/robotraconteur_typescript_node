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

import { connect, isIPv6, Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { parseConnectionUrl } from "robotraconteur";
import type { Endpoint, ITransportConnection, RobotRaconteurNode, Transport } from "robotraconteur";
import { connectionError, StreamClientConnection } from "robotraconteur/internal";
import type { SocketAdapter, SocketEvents, StreamTransportParent } from "robotraconteur/internal";
import type { WebSocket as WsWebSocket } from "ws";
import { interfaceScope, isIPv6LinkLocal } from "./NetworkUtil.js";
import { IPNodeDiscovery, IPNodeDiscoveryFlags } from "./IPNodeDiscovery.js";
import type { NodeAnnouncement } from "./IPNodeDiscovery.js";

/** A connected net.Socket, using the write return value and drain event for backpressure */
class TcpSocketAdapter implements SocketAdapter
{
    constructor(private socket: Socket) {}

    write(frame: Uint8Array): Promise<void> | void
    {
        if (this.socket.write(frame)) return;
        return new Promise<void>((resolve, reject) =>
        {
            const cleanup = () =>
            {
                this.socket.off("drain", on_drain);
                this.socket.off("close", on_close);
            };
            const on_drain = () =>
            {
                cleanup();
                resolve();
            };
            const on_close = () =>
            {
                cleanup();
                reject(connectionError("Transport connection closed"));
            };
            this.socket.once("drain", on_drain);
            this.socket.once("close", on_close);
        });
    }

    close(): void
    {
        this.socket.destroy();
    }
}

const WEBSOCKET_PROTOCOL = "robotraconteur.robotraconteur.com";
/** A send waits for the data to reach the socket once this many bytes are queued, as for a TCP socket */
const WEBSOCKET_SEND_HIGH_WATER_MARK = 16 * 1024;

/** Options for rr+ws and rr+wss connections, such as a certificate authority for a private server */
export interface WebSocketClientOptions
{
    /** Certificate authorities to trust in place of the defaults */
    ca?: string | Buffer | (string | Buffer)[];
    /** A client certificate and key, for servers that require one */
    cert?: string | Buffer;
    key?: string | Buffer;
    /** Set false only for testing. Defaults to true */
    rejectUnauthorized?: boolean;
    headers?: Record<string, string>;
}

/** A WebSocket from the ws package. Each send reports when its data has been written to the socket */
export class WebSocketAdapter implements SocketAdapter
{
    constructor(private ws: Pick<WsWebSocket, "readyState" | "bufferedAmount" | "send" | "terminate">) {}

    write(frame: Uint8Array): Promise<void> | void
    {
        if (this.ws.readyState !== 1) return Promise.reject(connectionError("Transport connection closed"));
        const sent = new Promise<void>((resolve, reject) =>
        {
            this.ws.send(frame, { binary: true }, (e) => (e ? reject(connectionError("Transport connection closed")) : resolve()));
        });
        // Like a socket write, continue at once while little is queued, and otherwise wait for it to be sent
        if (this.ws.bufferedAmount < WEBSOCKET_SEND_HIGH_WATER_MARK)
        {
            sent.catch(() => undefined);
            return;
        }
        return sent;
    }

    close(): void
    {
        this.ws.terminate();
    }
}

async function openWebSocket(url: string, timeout: number, options: WebSocketClientOptions, events: SocketEvents): Promise<SocketAdapter>
{
    // Loaded only when needed, so that rr+tcp works without it
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(url, WEBSOCKET_PROTOCOL, { ...options, handshakeTimeout: timeout, perMessageDeflate: false });
    await new Promise<void>((resolve, reject) =>
    {
        const on_error = () =>
        {
            ws.terminate();
            reject(connectionError("Could not connect to WebSocket endpoint"));
        };
        ws.once("error", on_error);
        ws.once("open", () =>
        {
            ws.off("error", on_error);
            resolve();
        });
    });
    ws.on("message", (data, is_binary) =>
    {
        if (is_binary) events.onData(data as Buffer);
    });
    ws.on("error", () => undefined); // Always followed by close
    ws.on("close", () => events.onClose());
    return new WebSocketAdapter(ws);
}

function openSocket(host: string, port: number, timeout: number): Promise<Socket>
{
    return new Promise<Socket>((resolve, reject) =>
    {
        const socket = connect({ host, port });
        socket.setNoDelay(true);
        const timer = setTimeout(() =>
        {
            socket.destroy();
            reject(connectionError("Timed out connecting to TCP endpoint"));
        }, timeout);
        const on_error = () =>
        {
            clearTimeout(timer);
            socket.destroy();
            reject(connectionError("Could not connect to TCP endpoint"));
        };
        socket.once("error", on_error);
        socket.once("connect", () =>
        {
            clearTimeout(timer);
            socket.off("error", on_error);
            resolve(socket);
        });
    });
}

/** A link-local address without a scope may be reachable through any interface, so all are tried */
function candidateHosts(url_host: string): string[]
{
    const host = url_host.replace(/^\[|\]$/g, "");
    if (!isIPv6(host) || !isIPv6LinkLocal(host) || host.includes("%")) return [host];

    const scopes = new Set<string>();
    for (const [name, addresses] of Object.entries(networkInterfaces()))
    {
        for (const a of addresses ?? [])
        {
            if (a.family === "IPv6" && isIPv6LinkLocal(a.address)) scopes.add(interfaceScope(name, a));
        }
    }
    return scopes.size > 0 ? [...scopes].map((s) => `${host}%${s}`) : [host];
}

async function connectAny(hosts: string[], port: number, timeout: number): Promise<Socket>
{
    let winner: Socket | undefined;
    const attempts = hosts.map(async (h) =>
    {
        const s = await openSocket(h, port, timeout);
        if (winner)
        {
            s.destroy();
            throw connectionError("Another connection was made first");
        }
        winner = s;
        return s;
    });
    try
    {
        return await Promise.any(attempts);
    }
    catch
    {
        throw connectionError("Could not connect to TCP endpoint");
    }
}

/**
 * Client transport for rr+tcp using a TCP socket, and for rr+ws and rr+wss using a WebSocket. Also
 * discovers nodes using UDP.
 */
export class TcpTransport implements Transport, StreamTransportParent
{
    /** Period for connection test messages in milliseconds */
    heartbeatPeriod = 5000;
    /** Connection is closed if the remote node has not been heard from for this long in milliseconds */
    defaultReceiveTimeout = 15000;
    defaultConnectTimeout = 5000;
    maxMessageSize = 12 * 1024 * 1024;
    /** Options for rr+ws and rr+wss connections */
    webSocketOptions: WebSocketClientOptions = {};

    private connections = new Set<StreamClientConnection>();
    private discovery: IPNodeDiscovery | null = null;

    constructor(public node: RobotRaconteurNode) {}

    canConnectService(url: string): boolean
    {
        return ["tcp", "rr+tcp", "rr+ws", "rr+wss"].includes(parseConnectionUrl(url).scheme);
    }

    async createTransportConnection(url: string, endpoint: Endpoint): Promise<ITransportConnection>
    {
        const u = parseConnectionUrl(url);
        if (u.host === "") throw connectionError("Invalid connection URL for TCP");

        const c = new StreamClientConnection(this, u.nodeid, u.nodename, endpoint);
        const websocket = u.scheme === "rr+ws" || u.scheme === "rr+wss";
        await c.connect(async (events) =>
        {
            if (websocket)
            {
                const ws_url = url.replace(u.scheme + "://", (u.scheme === "rr+wss" ? "wss" : "ws") + "://");
                return openWebSocket(ws_url, this.defaultConnectTimeout, this.webSocketOptions, events);
            }
            const socket = await connectAny(candidateHosts(u.host), u.port, this.defaultConnectTimeout);
            socket.on("data", (data) => events.onData(data));
            socket.on("error", () => undefined); // Always followed by close
            socket.on("close", () => events.onClose());
            return new TcpSocketAdapter(socket);
        });
        this.connections.add(c);
        return c;
    }

    removeConnection(c: StreamClientConnection): void
    {
        this.connections.delete(c);
    }

    /** Listen for node announcements. Core uses IPv6 link-local multicast by default */
    async enableNodeDiscoveryListening(on_announce: (a: NodeAnnouncement) => void, flags: number = IPNodeDiscoveryFlags.LinkLocal): Promise<void>
    {
        this.disableNodeDiscoveryListening();
        const d = new IPNodeDiscovery(on_announce, flags);
        await d.start();
        this.discovery = d;
    }

    disableNodeDiscoveryListening(): void
    {
        this.discovery?.close();
        this.discovery = null;
    }

    /** Whether listening for nodes keeps the process running, as a subscription should */
    setDiscoveryKeepAlive(keep_alive: boolean): void
    {
        this.discovery?.setKeepAlive(keep_alive);
    }

    /** Ask nodes to announce themselves now, instead of waiting for their periodic announcement */
    sendDiscoveryRequest(): void
    {
        this.discovery?.sendDiscoveryRequest();
    }

    close(): void
    {
        this.disableNodeDiscoveryListening();
        for (const c of [...this.connections]) c.close();
    }
}
