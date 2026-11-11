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

import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createServer } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { RobotRaconteurError } from "robotraconteur";
import { MessageErrorType } from "robotraconteur/internal";
import type { StreamConnection } from "robotraconteur/internal";
import type { SocketAdapter, SocketEvents, StreamTransportParent } from "robotraconteur/internal";
import { TcpSocketAdapter, WebSocketAdapter, WEBSOCKET_PROTOCOL } from "./SocketAdapters.js";
import type { WsLike } from "./SocketAdapters.js";
import { ServerStreamConnection } from "./StreamConnections.js";

/** The port of the Robot Raconteur port sharer, which a service must not listen on */
const PORT_SHARER_PORT = 48653;

/** Origins that may connect with a WebSocket, the defaults of Core */
/**
 * The host and port of the local end of an accepted socket, as Core reports it to the service
 * index, with IPv6 addresses in brackets without a scope
 */
export function urlHost(socket: { localAddress?: string; localPort?: number }): string
{
    let address = (socket.localAddress ?? "").replace(/%.*$/, "");
    if (address.startsWith("::ffff:") && address.includes(".")) address = address.substring(7);
    if (address === "" || !socket.localPort) return "";
    return `${address.includes(":") ? `[${address}]` : address}:${socket.localPort}`;
}

export const DEFAULT_WEBSOCKET_ALLOWED_ORIGINS: readonly string[] = [
    "null",
    "file://",
    "chrome-extension://",
    "http://robotraconteur.com",
    "http://robotraconteur.com:80",
    "http://*.robotraconteur.com",
    "http://*.robotraconteur.com:80",
    "https://robotraconteur.com",
    "https://robotraconteur.com:443",
    "https://*.robotraconteur.com",
    "https://*.robotraconteur.com:443"
];

/** Whether a browser page from an origin may connect, using the same rules as Core */
export function isWebSocketOriginAllowed(origin: string, allowed: readonly string[]): boolean
{
    if (allowed.includes(origin)) return true;
    const m = /^([^:\s]+:\/\/[^/]*).*$/.exec(origin);
    if (!m) return false;
    const o = m[1]!;
    for (const e of allowed)
    {
        if (!e.includes("*"))
        {
            if (e === o || (e.endsWith("://") && o.startsWith(e))) return true;
            continue;
        }
        const scheme_end = e.indexOf("://");
        if (scheme_end < 0) continue;
        const scheme = e.substring(0, scheme_end + 3);
        if (!o.startsWith(scheme)) continue;
        if (o.substring(scheme.length).endsWith(e.substring(scheme.length).replace("*", ""))) return true;
    }
    return false;
}

/** Settings of the transport that the server uses */
export interface TcpServerParent extends StreamTransportParent
{
    acceptWebSockets: boolean;
    webSocketAllowedOrigins: string[];
    maxConnectionCount: number;
    /** Milliseconds a client has to identify its protocol and create the connection */
    handshakeTimeout: number;
    addServerConnection(c: StreamConnection): void;
}

function httpError(socket: Duplex, status: string): void
{
    socket.end(`HTTP/1.1 ${status}\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: ${WEBSOCKET_PROTOCOL}\r\nSec-WebSocket-Version: 13\r\nConnection: close\r\n\r\n`);
    socket.destroy();
}

/**
 * Listens for clients on one port, as Core does. The first four bytes of a connection decide its
 * protocol: "RRAC" for the stream protocol, or "GET " for a WebSocket upgrade.
 */
export class TcpServer
{
    private servers: Server[] = [];
    private sockets = new Set<Socket>();
    private http: HttpServer | null = null;
    private wss: { handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, cb: (ws: WsLike & NodeJS.EventEmitter) => void): void } | null = null;
    private port = 0;

    constructor(private parent: TcpServerParent) {}

    get listenPort(): number
    {
        return this.port;
    }

    /** Listen on all addresses, or only on loopback. Port 0 picks a free port */
    /** Set if the server only accepts connections from this computer */
    localhostOnly = false;

    async start(port: number, localhost_only: boolean): Promise<void>
    {
        this.localhostOnly = localhost_only;
        if (port === PORT_SHARER_PORT) throw new RobotRaconteurError(MessageErrorType.InvalidArgument, "RobotRaconteur.InvalidArgument", "Port 48653 is reserved for the Robot Raconteur port sharer");
        try
        {
            if (localhost_only)
            {
                // Both loopback addresses on the same port, so that localhost works either way
                const p = await this.listen(port, "127.0.0.1");
                await this.listen(p, "::1").catch(() => undefined);
            }
            else
            {
                // A dual stack socket accepts IPv4 as well. Without IPv6, listen on IPv4 alone
                await this.listen(port, "::").catch(() => this.listen(port, "0.0.0.0"));
            }
        }
        catch (e)
        {
            this.close();
            throw new RobotRaconteurError(MessageErrorType.ConnectionError, "RobotRaconteur.ConnectionError", "Could not start TCP server: " + (e as Error).message);
        }
    }

    private listen(port: number, host: string): Promise<number>
    {
        return new Promise<number>((resolve, reject) =>
        {
            const s = createServer({ noDelay: true }, (socket) => this.acceptSocket(socket));
            s.once("error", reject);
            s.listen({ port, host, ipv6Only: false }, () =>
            {
                s.off("error", reject);
                s.on("error", () => undefined);
                this.servers.push(s);
                this.port = (s.address() as AddressInfo).port;
                resolve(this.port);
            });
        });
    }

    private acceptSocket(socket: Socket): void
    {
        const max = this.parent.maxConnectionCount;
        if (max > 0 && this.sockets.size >= max)
        {
            socket.destroy();
            return;
        }
        this.sockets.add(socket);
        socket.on("error", () => undefined); // Always followed by close
        socket.once("close", () => this.sockets.delete(socket));

        let head = Buffer.alloc(0);
        const timer = setTimeout(() => socket.destroy(), this.parent.handshakeTimeout);
        const on_data = (d: Buffer) =>
        {
            head = Buffer.concat([head, d]);
            if (head.length < 4) return;
            socket.off("data", on_data);
            socket.pause();
            clearTimeout(timer);
            const magic = head.subarray(0, 4).toString("latin1");
            if (magic === "RRAC")
            {
                void this.attachStream(socket, head);
            }
            else if (this.parent.acceptWebSockets && (magic === "GET " || magic === "GET\t"))
            {
                void this.attachHttp(socket, head);
            }
            else
            {
                socket.end("HTTP/1.1 404 File Not Found\r\n\r\n");
                socket.destroy();
            }
        };
        socket.on("data", on_data);
        socket.once("close", () => clearTimeout(timer));
    }

    /** Serve the stream protocol over a socket, giving it the bytes read to identify the protocol */
    private async attachStream(socket: Socket, head: Buffer): Promise<void>
    {
        const c = new ServerStreamConnection(this.parent);
        c.urlHost = urlHost(socket);
        let events: SocketEvents | undefined;
        const open = async (e: SocketEvents): Promise<SocketAdapter> =>
        {
            events = e;
            socket.on("data", (d: Buffer) => e.onData(d));
            socket.on("close", () => e.onClose());
            return new TcpSocketAdapter(socket);
        };
        try
        {
            await c.accept(open, this.parent.handshakeTimeout);
            this.parent.addServerConnection(c);
            events!.onData(head);
            socket.resume();
        }
        catch
        {
            socket.destroy();
        }
    }

    /** Hand the socket to an HTTP server, which upgrades it to a WebSocket */
    private async attachHttp(socket: Socket, head: Buffer): Promise<void>
    {
        try
        {
            if (!this.http)
            {
                const { createServer: createHttpServer } = await import("node:http");
                const { WebSocketServer } = await import("ws");
                this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: this.parent.maxMessageSize, handleProtocols: (protocols: Set<string>) => (protocols.has(WEBSOCKET_PROTOCOL) ? WEBSOCKET_PROTOCOL : false) }) as unknown as typeof this.wss;
                this.http = createHttpServer((_req, res) =>
                {
                    res.writeHead(404);
                    res.end();
                });
                this.http.on("upgrade", (req: IncomingMessage, s: Duplex, h: Buffer) => this.upgrade(req, s, h));
                this.http.on("clientError", (_e, s: Duplex) => s.destroy());
            }
            socket.unshift(head);
            this.http.emit("connection", socket);
            socket.resume();
        }
        catch
        {
            socket.destroy();
        }
    }

    /** Check the request as Core does, then accept the WebSocket */
    private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
    {
        const protocols = req.headers["sec-websocket-protocol"];
        if (protocols !== undefined && !protocols.split(",").some((p) => p.trim().toLowerCase() === WEBSOCKET_PROTOCOL))
        {
            httpError(socket, "426 Upgrade Required");
            return;
        }
        const origin = req.headers.origin;
        if (origin !== undefined && !isWebSocketOriginAllowed(origin, this.parent.webSocketAllowedOrigins))
        {
            httpError(socket, "403 Forbidden Origin");
            return;
        }
        this.wss!.handleUpgrade(req, socket, head, (ws) => void this.attachWebSocket(ws, urlHost(req.socket)));
    }

    private async attachWebSocket(ws: WsLike & NodeJS.EventEmitter, host: string): Promise<void>
    {
        const c = new ServerStreamConnection(this.parent);
        c.urlScheme = "rr+ws";
        c.urlHost = host;
        const open = async (e: SocketEvents): Promise<SocketAdapter> =>
        {
            ws.on("message", (data: Buffer, is_binary: boolean) =>
            {
                if (is_binary) e.onData(data);
            });
            ws.on("error", () => undefined); // Always followed by close
            ws.on("close", () => e.onClose());
            return new WebSocketAdapter(ws);
        };
        try
        {
            await c.accept(open, this.parent.handshakeTimeout);
            this.parent.addServerConnection(c);
        }
        catch
        {
            ws.terminate();
        }
    }

    /** Stop listening and drop connections that have not started a protocol */
    close(): void
    {
        for (const s of this.servers) s.close();
        this.servers = [];
        this.port = 0;
        this.http?.close();
        this.http = null;
        this.wss = null;
        for (const s of [...this.sockets]) s.destroy();
        this.sockets.clear();
    }
}
