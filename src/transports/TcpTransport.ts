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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { connect, isIPv6, Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect, TLSSocket } from "node:tls";
import { parseConnectionUrl, RobotRaconteurError } from "robotraconteur";
import type { Endpoint, ITransportConnection, RobotRaconteurNode, ServiceStub, Transport } from "robotraconteur";
import { connectionError, MessageErrorType, StreamClientConnection } from "robotraconteur/internal";
import type { SocketAdapter, SocketEvents, StreamTransportParent, TlsStarter } from "robotraconteur/internal";
import { CertificateError, verifyNodeCertificate } from "./NodeCertificate.js";
import { userConfigDir } from "./NodeDirectories.js";
import { ROOT_CA_2015, ROOT_CA_2020 } from "./RootCertificates.js";
import { interfaceScope, isIPv6LinkLocal } from "./NetworkUtil.js";
import { IPNodeDiscovery, IPNodeDiscoveryFlags } from "./IPNodeDiscovery.js";
import type { NodeAnnouncement } from "./IPNodeDiscovery.js";

/** A connected net.Socket or TLS socket, using the write return value and drain event for backpressure */
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

/** The parts of a WebSocket from the ws package that are used, so that its types are not needed by users */
interface WsLike
{
    readonly readyState: number;
    readonly bufferedAmount: number;
    send(data: Uint8Array, options: { binary: boolean }, cb: (err?: Error) => void): void;
    terminate(): void;
}

/** A WebSocket from the ws package. Each send reports when its data has been written to the socket */
export class WebSocketAdapter implements SocketAdapter
{
    constructor(private ws: WsLike) {}

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
    catch (e)
    {
        const reasons = (e as AggregateError).errors.map((r) => (r as Error).message);
        throw reasons.length === 1 ? (e as AggregateError).errors[0] : connectionError(reasons.join("; "));
    }
}

/**
 * Client transport for rr+tcp and rrs+tcp using a TCP socket, and for rr+ws and rr+wss using a
 * WebSocket. Also discovers nodes using UDP.
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
    /** Options for rrs+tcp connections */
    tlsOptions: TlsClientOptions = {};
    /**
     * Only connect using rrs+tcp, so that every connection uses TLS and a verified certificate. As
     * Core does with RequireTls.
     */
    requireTls = false;

    private connections = new Set<StreamClientConnection>();
    private discovery: IPNodeDiscovery | null = null;

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

        const c = new StreamClientConnection(this, u.nodeid, u.nodename, endpoint);
        const websocket = u.scheme === "rr+ws" || u.scheme === "rr+wss";
        let start_tls: TlsStarter | undefined;
        const open = async (events: SocketEvents): Promise<SocketAdapter> =>
        {
            if (websocket)
            {
                const ws_url = url.replace(u.scheme + "://", (u.scheme === "rr+wss" ? "wss" : "ws") + "://");
                return openWebSocket(ws_url, this.defaultConnectTimeout, this.webSocketOptions, events);
            }
            const socket = await connectAny(candidateHosts(u.host), u.port, this.defaultConnectTimeout);
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

    removeConnection(c: StreamClientConnection): void
    {
        this.connections.delete(c);
    }

    private connectionOf(client: ServiceStub): StreamClientConnection
    {
        const c = client.context.transportConnection as StreamClientConnection | null;
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
        this.disableNodeDiscoveryListening();
        for (const c of [...this.connections]) c.close();
    }
}
