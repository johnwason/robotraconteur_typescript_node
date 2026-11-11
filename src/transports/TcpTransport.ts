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

import { X509Certificate } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { connect, isIP, isIPv6, Socket } from "node:net";
import type { LookupFunction } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect, TLSSocket } from "node:tls";
import { parseConnectionUrl, RobotRaconteurError } from "robotraconteur";
import type { Endpoint, ITransportConnection, RobotRaconteurNode, ServiceStub, Transport } from "robotraconteur";
import { connectionError, MessageErrorType, StreamConnection } from "robotraconteur/internal";
import { TcpSocketAdapter, WebSocketAdapter, WEBSOCKET_PROTOCOL } from "./SocketAdapters.js";

export { WebSocketAdapter };
import type { SocketAdapter, SocketEvents, TlsStarter } from "robotraconteur/internal";
import { CertificateError, verifyNodeCertificate } from "./NodeCertificate.js";
import { userConfigDir } from "./NodeDirectories.js";
import { ROOT_CA_2015, ROOT_CA_2020 } from "./RootCertificates.js";
import { interfaceScope, isIPv6LinkLocal } from "./NetworkUtil.js";
import { IPNodeDiscovery, IPNodeDiscoveryFlags } from "./IPNodeDiscovery.js";
import type { NodeAnnouncement } from "./IPNodeDiscovery.js";
import { DEFAULT_WEBSOCKET_ALLOWED_ORIGINS, TcpServer } from "./TcpServer.js";
import type { TcpServerParent } from "./TcpServer.js";


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

const LOOPBACK: LookupAddress[] = [{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }];

/** Host lookup for WebSockets that, like candidateHosts, gives both loopback addresses for localhost */
const webSocketLookup = ((hostname: string, options: LookupOptions, callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void) =>
{
    if (hostname.toLowerCase() !== "localhost")
    {
        dnsLookup(hostname, options, callback as never);
        return;
    }
    const addresses = LOOPBACK.filter((a) => !options.family || a.family === options.family);
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
}) as LookupFunction;

async function openWebSocket(url: string, timeout: number, options: WebSocketClientOptions, events: SocketEvents): Promise<SocketAdapter>
{
    // Loaded only when needed, so that rr+tcp works without it
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(url, WEBSOCKET_PROTOCOL, { lookup: webSocketLookup, ...options, handshakeTimeout: timeout, perMessageDeflate: false });
    await new Promise<void>((resolve, reject) =>
    {
        const on_error = (err: Error) =>
        {
            ws.terminate();
            reject(connectionError(`Could not connect to WebSocket endpoint ${url}: ${err.message}`));
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

/** Options for rrs+tcp connections, which use TLS with Robot Raconteur node certificates */
export interface TlsClientOptions
{
    /**
     * Root certificates to trust, as PEM or DER, for a site with its own certificate authority. Its
     * certificates must carry the same Robot Raconteur extensions as node certificates.
     */
    trustedRoots?: (string | Buffer)[];
    /**
     * Trust the Robot Raconteur root certificates built into Core. Defaults to true. As in Core, the
     * environment variables ROBOTRACONTEUR_NO_DEFAULT_ROOT_CERT, ROBOTRACONTEUR_NO_DEFAULT_ROOT_CERT_2015,
     * and ROBOTRACONTEUR_NO_DEFAULT_ROOT_CERT_2020 set to true turn them off. Also as in Core,
     * certificates in the PEM files named by ROBOTRACONTEUR_SSL_CERT_FILE, or in the folder named by
     * ROBOTRACONTEUR_SSL_CERT_DIR, are trusted as well.
     */
    useDefaultRoots?: boolean;
    /**
     * A certificate and key for this node as PKCS#12, sent to servers that check clients. It must be
     * the certificate for the node ID of this node.
     */
    clientCertificate?: { pfx: string | Buffer; passphrase?: string };
}

function envTrue(name: string): boolean
{
    const v = process.env[name]?.trim().toLowerCase();
    return v === "true" || v === "1";
}

function trustedRoots(options: TlsClientOptions): X509Certificate[]
{
    const roots: string[] = [];
    if (options.useDefaultRoots ?? true)
    {
        const none = envTrue("ROBOTRACONTEUR_NO_DEFAULT_ROOT_CERT");
        if (!none && !envTrue("ROBOTRACONTEUR_NO_DEFAULT_ROOT_CERT_2015")) roots.push(ROOT_CA_2015);
        if (!none && !envTrue("ROBOTRACONTEUR_NO_DEFAULT_ROOT_CERT_2020")) roots.push(ROOT_CA_2020);
    }
    return [...roots, ...environmentRoots(), ...(options.trustedRoots ?? [])].map((r) => new X509Certificate(r));
}

function pemCertificates(file: string): string[]
{
    try
    {
        return readFileSync(file, "utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    }
    catch
    {
        // As in Core, a file that cannot be read is skipped
        return [];
    }
}

/** Certificates trusted through the environment variables Core reads */
function environmentRoots(): string[]
{
    const out: string[] = [];
    const file = process.env.ROBOTRACONTEUR_SSL_CERT_FILE;
    if (file) out.push(...pemCertificates(file));
    const dir = process.env.ROBOTRACONTEUR_SSL_CERT_DIR;
    if (dir)
    {
        let names: string[] = [];
        try
        {
            names = readdirSync(dir);
        }
        catch
        {
            // Skipped, as above
        }
        for (const n of names)
        {
            const p = join(dir, n);
            try
            {
                if (statSync(p).isFile()) out.push(...pemCertificates(p));
            }
            catch
            {
                // Skipped, as above
            }
        }
    }
    return out;
}

function authenticationError(message: string): RobotRaconteurError
{
    return new RobotRaconteurError(MessageErrorType.AuthenticationError, "RobotRaconteur.AuthenticationError", message);
}

/** The certificates the peer sent, its own first */
function peerChain(s: TLSSocket): Uint8Array[]
{
    const out: Uint8Array[] = [];
    const seen = new Set<string>();
    for (let c = s.getPeerCertificate(true); c?.raw && !seen.has(c.fingerprint256); c = c.issuerCertificate)
    {
        seen.add(c.fingerprint256);
        out.push(c.raw);
    }
    return out;
}

/**
 * Switch a connected socket to TLS. The verification of Node.js is turned off because it rejects
 * every node certificate, so the chain is checked by verifyNodeCertificate before any data is sent.
 */
function tlsStarter(socket: Socket, listeners: { data: (d: Buffer) => void; close: () => void }, node: RobotRaconteurNode, options: TlsClientOptions, timeout: number): TlsStarter
{
    return async (events, peer) =>
    {
        socket.off("data", listeners.data);
        socket.off("close", listeners.close);
        const client = peer.mutualAuth ? options.clientCertificate : undefined;

        const s = await new Promise<TLSSocket>((resolve, reject) =>
        {
            const t = tlsConnect({ socket, rejectUnauthorized: false, minVersion: "TLSv1.2", ...(client ? { pfx: client.pfx, passphrase: client.passphrase } : {}) });
            const timer = setTimeout(() =>
            {
                t.destroy();
                reject(connectionError("Timed out starting TLS"));
            }, timeout);
            t.once("secureConnect", () =>
            {
                clearTimeout(timer);
                resolve(t);
            });
            t.once("error", (e) =>
            {
                clearTimeout(timer);
                t.destroy();
                reject(connectionError("Could not start TLS: " + e.message));
            });
        });

        try
        {
            verifyNodeCertificate(peerChain(s), { roots: trustedRoots(options), nodeID: peer.nodeID });
            if (client)
            {
                const own = s.getX509Certificate();
                const expected = `CN=Robot Raconteur Node ${node.nodeID.toString()}`;
                if (own?.subject !== expected) throw new CertificateError(`The client certificate is not for this node, ${node.nodeID.toString()}`);
            }
        }
        catch (e)
        {
            s.destroy();
            throw authenticationError("Could not verify TLS certificate: " + (e as Error).message);
        }

        s.on("data", (d: Buffer) => events.onData(d));
        s.on("error", () => undefined); // Always followed by close
        s.on("close", () => events.onClose());
        return new TcpSocketAdapter(s);
    };
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
        const on_error = (err: Error) =>
        {
            clearTimeout(timer);
            socket.destroy();
            reject(connectionError(`Could not connect to TCP endpoint ${host}:${port}: ${err.message}`));
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
/**
 * The addresses to try for a host. Like Core, a name is resolved and every address is tried, since
 * a server may listen on only one of the addresses a name resolves to, such as 127.0.0.1 for localhost.
 */
async function candidateHosts(url_host: string): Promise<string[]>
{
    const host = url_host.replace(/^\[|\]$/g, "");
    if (isIP(host.replace(/%.*$/, "")) === 0)
    {
        // localhost is always loopback (RFC 6761). Windows resolves it only to ::1, but a server may
        // listen on 127.0.0.1 alone, or on a different port for each, as Core does when given port 0
        const loopback = host.toLowerCase() === "localhost" ? ["127.0.0.1", "::1"] : [];
        let addresses: string[];
        try
        {
            addresses = (await lookup(host, { all: true })).map((a) => a.address);
        }
        catch (e)
        {
            if (loopback.length > 0) return loopback;
            throw connectionError(`Could not resolve host ${host}: ${(e as Error).message}`);
        }
        const all = [...new Set([...addresses, ...loopback])];
        return all.length > 0 ? all : [host];
    }
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
    catch (e)
    {
        const reasons = (e as AggregateError).errors.map((r) => (r as Error).message);
        throw reasons.length === 1 ? (e as AggregateError).errors[0] : connectionError(reasons.join("; "));
    }
}

/**
 * Transport for rr+tcp and rrs+tcp using a TCP socket, and for rr+ws and rr+wss using a WebSocket.
 * It connects clients, serves services after startServer(), and discovers nodes using UDP.
 */
export class TcpTransport implements Transport, TcpServerParent
{
    /** Period for connection test messages in milliseconds */
    heartbeatPeriod = 5000;
    /** Connection is closed if the remote node has not been heard from for this long in milliseconds */
    defaultReceiveTimeout = 15000;
    defaultConnectTimeout = 5000;
    maxMessageSize = 12 * 1024 * 1024;
    /** Options for rr+ws and rr+wss connections */
    webSocketOptions: WebSocketClientOptions = {};
    /** Options for rrs+tcp connections */
    tlsOptions: TlsClientOptions = {};
    /**
     * Only connect using rrs+tcp, so that every connection uses TLS and a verified certificate. As
     * Core does with RequireTls.
     */
    requireTls = false;

    /** Accept WebSocket clients on the server port, as Core does */
    acceptWebSockets = true;
    /** Origins of browser pages that may connect with a WebSocket. Core's defaults */
    webSocketAllowedOrigins: string[] = [...DEFAULT_WEBSOCKET_ALLOWED_ORIGINS];
    /** Maximum number of client sockets the server accepts at once. 0 for no limit */
    maxConnectionCount = 0;
    /** Milliseconds a client has to identify its protocol and create the connection */
    handshakeTimeout = 10000;

    private connections = new Set<StreamConnection>();
    private discovery: IPNodeDiscovery | null = null;
    private server: TcpServer | null = null;

    constructor(public node: RobotRaconteurNode) {}

    canConnectService(url: string): boolean
    {
        return ["tcp", "rr+tcp", "rrs+tcp", "rr+ws", "rr+wss"].includes(parseConnectionUrl(url).scheme);
    }

    async createTransportConnection(url: string, endpoint: Endpoint): Promise<ITransportConnection>
    {
        const u = parseConnectionUrl(url);
        if (u.host === "") throw connectionError("Invalid connection URL for TCP");
        if (this.requireTls && u.scheme !== "rrs+tcp") throw connectionError(`TLS is required, so ${u.scheme} cannot be used. Use rrs+tcp`);

        const c = new StreamConnection(this, u.nodeid, u.nodename, endpoint);
        const websocket = u.scheme === "rr+ws" || u.scheme === "rr+wss";
        let start_tls: TlsStarter | undefined;
        const open = async (events: SocketEvents): Promise<SocketAdapter> =>
        {
            if (websocket)
            {
                const ws_url = url.replace(u.scheme + "://", (u.scheme === "rr+wss" ? "wss" : "ws") + "://");
                return openWebSocket(ws_url, this.defaultConnectTimeout, this.webSocketOptions, events);
            }
            const socket = await connectAny(await candidateHosts(u.host), u.port, this.defaultConnectTimeout);
            const listeners = { data: (data: Buffer) => events.onData(data), close: () => events.onClose() };
            socket.on("data", listeners.data);
            socket.on("error", () => undefined); // Always followed by close
            socket.on("close", listeners.close);
            start_tls = tlsStarter(socket, listeners, this.node, this.tlsOptions, this.defaultConnectTimeout);
            return new TcpSocketAdapter(socket);
        };

        if (u.scheme === "rrs+tcp")
        {
            // TLS starts after the socket opens, so the starter is looked up when it is needed
            await c.connect(open, { start: (events, peer) => start_tls!(events, peer), mutualAuth: this.tlsOptions.clientCertificate !== undefined });
        }
        else
        {
            await c.connect(open);
        }
        this.connections.add(c);
        return c;
    }

    removeConnection(c: StreamConnection): void
    {
        this.connections.delete(c);
    }

    addServerConnection(c: StreamConnection): void
    {
        this.connections.add(c);
    }

    /**
     * Listen for clients on a port, for services registered with node.registerService. Port 0
     * picks a free port, which listenPort reports. As in Core, rr+ws clients are accepted on the
     * same port.
     */
    async startServer(port = 0, options: { localhostOnly?: boolean } = {}): Promise<void>
    {
        if (this.server) throw new RobotRaconteurError(MessageErrorType.InvalidOperation, "RobotRaconteur.InvalidOperation", "Server already started");
        const server = new TcpServer(this);
        await server.start(port, options.localhostOnly ?? false);
        this.server = server;
    }

    /** Stop listening. Connected clients are not affected */
    stopServer(): void
    {
        this.server?.close();
        this.server = null;
    }

    /** The port the server listens on, or 0 if it is not listening */
    get listenPort(): number
    {
        return this.server?.listenPort ?? 0;
    }

    /** URLs that clients on this computer can use to connect to a service of this node */
    getServerListenUrls(service: string): string[]
    {
        const port = this.listenPort;
        if (port === 0) return [];
        const id = this.node.nodeID.toString().replace(/[{}]/g, "");
        return [`rr+tcp://localhost:${port}?nodeid=${id}&service=${service}`];
    }

    private connectionOf(client: ServiceStub): StreamConnection
    {
        const c = client.context.transportConnection as StreamConnection | null;
        if (!c || !this.connections.has(c)) throw connectionError("The client is not connected using this transport");
        return c;
    }

    /** Whether a client's connection uses TLS. Throws if it is not connected using this transport */
    isTransportConnectionSecure(client: ServiceStub): boolean
    {
        return this.connectionOf(client).secure;
    }

    /**
     * Whether the service's node certificate has been verified. TLS is only used once it has been,
     * so this is the same as isTransportConnectionSecure.
     */
    isSecurePeerIdentityVerified(client: ServiceStub): boolean
    {
        return this.connectionOf(client).secure;
    }

    /** The node ID of the service, verified by its certificate. Throws if it has not been verified */
    getSecurePeerIdentity(client: ServiceStub): string
    {
        const c = this.connectionOf(client);
        if (!c.secure) throw authenticationError("Peer identity is not verified");
        return c.remoteNodeID.toString();
    }

    /**
     * Load the certificate of this node from where Core keeps it, certificates/{nodeid}.p12 in its
     * configuration folder, to send to services that check clients. Set the node ID first.
     */
    loadTlsNodeCertificate(): void
    {
        const file = join(userConfigDir(), "certificates", this.node.nodeID.toString() + ".p12");
        let pfx: Buffer;
        try
        {
            pfx = readFileSync(file);
        }
        catch
        {
            throw connectionError(`Could not load node certificate ${file}`);
        }
        this.tlsOptions = { ...this.tlsOptions, clientCertificate: { pfx } };
    }

    /** Whether a certificate for this node has been loaded or given in tlsOptions */
    get isTlsNodeCertificateLoaded(): boolean
    {
        return this.tlsOptions.clientCertificate !== undefined;
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
        this.stopServer();
        this.disableNodeDiscoveryListening();
        for (const c of [...this.connections]) c.close();
    }
}
