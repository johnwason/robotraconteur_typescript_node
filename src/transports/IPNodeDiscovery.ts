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

import { createSocket, Socket } from "node:dgram";
import { isIP } from "node:net";
import { NetworkInterfaceInfo, networkInterfaces } from "node:os";
import { NodeID, parseConnectionUrl } from "robotraconteur";
import { interfaceScope, isIPv6LinkLocal, isIPv6SiteLocal, isLoopback } from "./NetworkUtil.js";

/** Which addresses are used for discovery. These values are the same as in Core */
export const IPNodeDiscoveryFlags = {
    /** IPv6 FF01:: node-local multicast */
    NodeLocal: 0x1,
    /** IPv6 FF02:: link-local multicast */
    LinkLocal: 0x2,
    /** IPv6 FF05:: site-local multicast */
    SiteLocal: 0x4,
    /** IPv4 255.255.255.255 broadcast */
    IPv4Broadcast: 0x8
} as const;

const ANNOUNCE_PORT = 48653;
const MAX_PACKET_SIZE = 4096;
const ANNOUNCE_MAGIC = "Robot Raconteur Node Discovery Packet";
const REQUEST_MAGIC = "Robot Raconteur Discovery Request Packet";

const MULTICAST_GROUPS: [number, string][] = [
    [IPNodeDiscoveryFlags.NodeLocal, "ff01::ba86"],
    [IPNodeDiscoveryFlags.LinkLocal, "ff02::ba86"],
    [IPNodeDiscoveryFlags.SiteLocal, "ff05::ba86"]
];

/** The unverified contents of a node announcement packet */
export interface NodeAnnouncement
{
    /** The announcing node */
    nodeID: NodeID;
    /** Its name, which may be empty */
    nodeName: string;
    /** The URL of its service index */
    url: string;
    /** Changes when the node's services change. Empty if it did not send one */
    serviceStateNonce: string;
}

function hostFamilyMatches(host: string, sender: string): boolean
{
    const family = isIP(host);
    if (family === 0) return false;
    if (isLoopback(host)) return true;
    if (family !== isIP(sender)) return false;
    if (family === 6) return isIPv6LinkLocal(host) || isIPv6SiteLocal(host);
    const a = host.split(".");
    const b = sender.split(".");
    return a[0] === b[0] && a[1] === b[1];
}

/** Parse and check a discovery packet, applying the same checks as Core. Returns null if invalid */
export function parseNodeAnnouncement(packet: string, sender: string): NodeAnnouncement | null
{
    if (!packet.startsWith(ANNOUNCE_MAGIC)) return null;
    const lines = packet.split("\n");
    if (lines.length < 3) return null;

    const id_line = lines[1]!.split(",");
    const url = lines[2]!;
    if (url.length > 256) return null;

    try
    {
        const nodeID = new NodeID(id_line[0]!);
        const u = parseConnectionUrl(url);
        if (!u.nodeid.equals(nodeID)) return null;

        const host = u.host.replace(/^\[|\]$/g, "");
        if (!hostFamilyMatches(host.split("%")[0]!, sender.split("%")[0]!)) return null;

        let serviceStateNonce = "";
        for (const line of lines.slice(3))
        {
            const m = /^\s*([\w+.-]+)\s*:\s*(.*?)\s*$/.exec(line);
            if (m && m[1] === "ServiceStateNonce" && m[2]!.length < 32) serviceStateNonce = m[2]!;
        }

        const name = id_line[1] ?? "";
        return { nodeID, nodeName: name.length > 128 ? "" : name, url, serviceStateNonce };
    }
    catch
    {
        return null;
    }
}

/** A local address that discovery packets can be sent from */
interface LocalAddress
{
    address: string;
    scope: string;
    info: NetworkInterfaceInfo;
}

function localAddresses(): LocalAddress[]
{
    const out: LocalAddress[] = [];
    for (const [name, addresses] of Object.entries(networkInterfaces()))
    {
        for (const info of addresses ?? [])
        {
            if (info.family === "IPv6" && !isIPv6LinkLocal(info.address) && !isLoopback(info.address)) continue;
            out.push({ address: info.address, scope: interfaceScope(name, info), info });
        }
    }
    return out;
}

function bindSocket(socket: Socket, options: { port: number; address: string }): Promise<void>
{
    return new Promise<void>((resolve, reject) =>
    {
        socket.once("error", reject);
        socket.bind(options, () =>
        {
            socket.off("error", reject);
            resolve();
        });
    });
}

async function sendFrom(source: LocalAddress, data: Buffer, flags: number): Promise<void>
{
    const v6 = source.info.family === "IPv6";
    if (!v6 && !(flags & IPNodeDiscoveryFlags.IPv4Broadcast)) return;

    const socket = createSocket({ type: v6 ? "udp6" : "udp4", reuseAddr: true });
    socket.on("error", () => undefined);
    try
    {
        await bindSocket(socket, { port: 0, address: v6 ? `${source.address}%${source.scope}` : source.address });
        const destinations: string[] = [];
        if (v6)
        {
            socket.setMulticastInterface(`::%${source.scope}`);
            socket.setMulticastLoopback(true);
            for (const [flag, group] of MULTICAST_GROUPS)
            {
                if (!(flags & flag)) continue;
                if (isLoopback(source.address) && flag !== IPNodeDiscoveryFlags.NodeLocal) continue;
                destinations.push(`${group}%${source.scope}`);
            }
        }
        else
        {
            socket.setBroadcast(true);
            destinations.push("255.255.255.255");
        }
        for (const d of destinations)
        {
            await new Promise<void>((resolve) => socket.send(data, ANNOUNCE_PORT, d, () => resolve()));
        }
    }
    finally
    {
        socket.close();
    }
}

function joinGroups(socket: Socket, flags: number): void
{
    const scopes = new Set(localAddresses().filter((a) => a.info.family === "IPv6").map((a) => a.scope));
    for (const [flag, group] of MULTICAST_GROUPS)
    {
        if (!(flags & flag)) continue;
        for (const scope of scopes)
        {
            try
            {
                socket.addMembership(group, `::%${scope}`);
            }
            catch
            {
                // Not every interface supports multicast
            }
        }
    }
}

/** Listens for UDP node announcements and sends discovery requests */
export class IPNodeDiscovery
{
    private sockets: Socket[] = [];
    /** The ID in this node's discovery requests, which its own announcer ignores */
    readonly requestID = NodeID.newUniqueID();
    private request_timer: ReturnType<typeof setTimeout> | undefined;
    private closed = false;

    constructor(private on_announce: (a: NodeAnnouncement) => void, private flags: number) {}

    async start(): Promise<void>
    {
        if (this.flags & IPNodeDiscoveryFlags.IPv4Broadcast) await this.listen("udp4", "0.0.0.0");
        if (MULTICAST_GROUPS.some(([f]) => this.flags & f))
        {
            const socket = await this.listen("udp6", "::");
            if (socket) joinGroups(socket, this.flags);
        }
        if (this.sockets.length === 0) throw new Error("Could not listen for node announcements");
        this.sendDiscoveryRequest();
    }

    setKeepAlive(keep_alive: boolean): void
    {
        for (const s of this.sockets)
        {
            if (keep_alive) s.ref();
            else s.unref();
        }
    }

    private async listen(type: "udp4" | "udp6", address: string): Promise<Socket | null>
    {
        const socket = createSocket({ type, reuseAddr: true, ipv6Only: type === "udp6" });
        try
        {
            await bindSocket(socket, { port: ANNOUNCE_PORT, address });
        }
        catch
        {
            socket.close();
            return null;
        }
        socket.on("error", () => undefined);
        socket.on("message", (data, rinfo) => this.packetReceived(data, rinfo.address));
        socket.unref();
        this.sockets.push(socket);
        return socket;
    }

    private packetReceived(data: Buffer, sender: string): void
    {
        if (this.closed || data.length > MAX_PACKET_SIZE) return;
        const announcement = parseNodeAnnouncement(data.toString("ascii"), sender);
        if (announcement) this.on_announce(announcement);
    }

    /** Send a request now and twice more, as UDP packets can be lost */
    sendDiscoveryRequest(): void
    {
        clearTimeout(this.request_timer);
        const send = (remaining: number) =>
        {
            if (this.closed) return;
            this.broadcast(`${REQUEST_MAGIC}\n${this.requestID.toString()}\n`);
            if (remaining <= 1) return;
            this.request_timer = setTimeout(() => send(remaining - 1), 900 + Math.random() * 600);
            this.request_timer.unref();
        };
        send(3);
    }

    private broadcast(packet: string): void
    {
        for (const a of localAddresses())
        {
            void sendFrom(a, Buffer.from(packet, "ascii"), this.flags).catch(() => undefined);
        }
    }

    close(): void
    {
        this.closed = true;
        clearTimeout(this.request_timer);
        for (const s of this.sockets) s.close();
        this.sockets.length = 0;
    }
}

/**
 * Announces this node, as Core's IPNodeDiscovery does for a node that serves: 500 ms after
 * starting, every period after that, soon after the node's services change, and when another
 * node sends a discovery request. packets(address) gives the packets to send from a local address,
 * one for each URL scheme, or none.
 */
export class NodeAnnouncer
{
    /** Milliseconds between announcements. Core's default for TCP */
    period = 55000;

    private sockets: Socket[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;
    private due = 0;
    private closed = false;

    constructor(private packets: (address: string) => string[], private flags: number, private is_own_request: (id: NodeID) => boolean = () => false) {}

    async start(): Promise<void>
    {
        // Listen for discovery requests on the announcement port. Announcements still go out if
        // another program holds the port without sharing it
        if (this.flags & IPNodeDiscoveryFlags.IPv4Broadcast) await this.listen("udp4", "0.0.0.0");
        if (MULTICAST_GROUPS.some(([f]) => this.flags & f))
        {
            const socket = await this.listen("udp6", "::");
            if (socket) joinGroups(socket, this.flags);
        }
        this.schedule(500);
    }

    /** Announce within 500 ms, as Core does when the node's services change */
    announceNow(): void
    {
        this.schedule(500);
    }

    private schedule(delay: number): void
    {
        if (this.closed) return;
        const due = Date.now() + delay;
        if (this.timer !== undefined && this.due <= due) return;
        clearTimeout(this.timer);
        this.due = due;
        this.timer = setTimeout(() => this.announce(), delay);
        this.timer.unref();
    }

    private announce(): void
    {
        this.timer = undefined;
        if (this.closed) return;
        for (const a of localAddresses())
        {
            for (const p of this.packets(a.address))
            {
                void sendFrom(a, Buffer.from(p, "ascii"), this.flags).catch(() => undefined);
            }
        }
        this.schedule(this.period);
    }

    private async listen(type: "udp4" | "udp6", address: string): Promise<Socket | null>
    {
        const socket = createSocket({ type, reuseAddr: true, ipv6Only: type === "udp6" });
        try
        {
            await bindSocket(socket, { port: ANNOUNCE_PORT, address });
        }
        catch
        {
            socket.close();
            return null;
        }
        socket.on("error", () => undefined);
        socket.on("message", (data) => this.packetReceived(data));
        socket.unref();
        this.sockets.push(socket);
        return socket;
    }

    private packetReceived(data: Buffer): void
    {
        if (this.closed || data.length > MAX_PACKET_SIZE) return;
        const packet = data.toString("ascii");
        if (!packet.startsWith(REQUEST_MAGIC)) return;
        const lines = packet.split("\n");
        if (lines.length < 3) return;
        try
        {
            if (!this.is_own_request(new NodeID(lines[1]!.split(",")[0]!))) this.announceNow();
        }
        catch
        {
            // Not a valid request
        }
    }

    close(): void
    {
        this.closed = true;
        clearTimeout(this.timer);
        for (const s of this.sockets) s.close();
        this.sockets.length = 0;
    }
}
