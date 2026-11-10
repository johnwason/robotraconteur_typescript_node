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

import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { NodeID, RobotRaconteurNode } from "robotraconteur";
import type { RobotRaconteurError } from "robotraconteur";
import { TcpTransport } from "../../src/index.js";
import type { TlsClientOptions } from "../../src/index.js";
import { TestCertificates } from "../common/TestCertificates.js";
import { root } from "./TestServer.js";

// rrs+tcp against Core TLS servers, using a certificate authority made for the test. Core is told to
// trust it for client certificates with ROBOTRACONTEUR_SSL_CERT_FILE.

const certs = new TestCertificates();
const ca = certs.root();
const intermediate = certs.intermediate(ca);
const servers: ChildProcess[] = [];

interface Server
{
    id: NodeID;
    port: number;
}

/** Start a Core TLS server as the given node, presenting a certificate for certificate_id, or for itself if that is Any */
async function startServer(name: string, id: NodeID, certificate_id: NodeID, trust_ca: boolean): Promise<Server>
{
    const config = join(certs.dir, name);
    const cert = certs.node(intermediate, (certificate_id.isAnyNode ? id : certificate_id).toString(), name);
    certs.pkcs12(cert, [intermediate], join(config, "certificates", id.toString() + ".p12"));
    const args = ["-u", join(root, "test/server/rr_tls_test_server.py"), id.toString(), config, ...(trust_ca ? ["--ca", ca.certFile] : [])];
    const p = spawn("python3", args, { stdio: ["pipe", "pipe", "inherit"] });
    servers.push(p);
    const port = await new Promise<number>((resolve, reject) =>
    {
        let out = "";
        p.stdout!.on("data", (d: Buffer) =>
        {
            out += d.toString();
            const m = /PORT (\d+)\n/.exec(out);
            if (m) resolve(Number(m[1]));
        });
        p.on("exit", () => reject(new Error("TLS test server exited")));
    });
    return { id, port };
}

let server: Server;
let impostor: Server;
let no_client_ca: Server;

before(async () =>
{
    server = await startServer("server", NodeID.newUniqueID(), NodeID.Any, true);
    impostor = await startServer("impostor", NodeID.newUniqueID(), NodeID.newUniqueID(), true);
    no_client_ca = await startServer("no_client_ca", NodeID.newUniqueID(), NodeID.Any, false);
}, { timeout: 60000 });

after(() =>
{
    for (const p of servers)
    {
        p.removeAllListeners("exit");
        p.kill();
    }
    certs.close();
});

const trust_test_ca: TlsClientOptions = { trustedRoots: [ca.pem], useDefaultRoots: false };
const id_of = (s: Server) => s.id.toString().slice(1, -1);
const url = (s: Server, query = `nodeid=${id_of(s)}&`) => `rrs+tcp://localhost:${s.port}?${query}service=test_service`;

async function withNode<T>(options: TlsClientOptions, fn: (node: RobotRaconteurNode) => Promise<T>, node_id?: NodeID): Promise<T>
{
    const node = new RobotRaconteurNode();
    if (node_id) node.nodeID = node_id;
    const tcp = new TcpTransport(node);
    tcp.tlsOptions = options;
    node.registerTransport(tcp);
    try
    {
        return await fn(node);
    }
    finally
    {
        await node.shutdown();
    }
}

const named = (name: string) => (e: RobotRaconteurError) => e.errorName === name;

test("rrs+tcp connects to a server with a trusted certificate", { timeout: 30000 }, async () =>
{
    await withNode(trust_test_ca, async (node) =>
    {
        const c = await node.connectService(url(server));
        assert.equal(await c.callFunction("add_two_numbers", [2, 4]), 6);
        assert.ok(c.context.remoteNodeID.equals(server.id));
        // The certificate is checked against the node that answered when the URL names none
        const any = await node.connectService(url(server, ""));
        assert.equal(await any.callFunction("add_two_numbers", [1, 1]), 2);
    });
});

// Make certificates now, so that the next tests do not include the time taken by openssl
const client_id = NodeID.newUniqueID();
const client_p12 = certs.pkcs12(certs.node(intermediate, client_id.toString(), "client"), [intermediate], join(certs.dir, "client.p12"));

test("rrs+tcp refuses a server whose certificate is not trusted", { timeout: 30000 }, async () =>
{
    await withNode({}, async (node) =>
    {
        await assert.rejects(node.connectService(url(server)), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.AuthenticationError" && /not issued by a trusted/.test(e.message));
    });
});

test("rrs+tcp refuses a server whose certificate is for another node", { timeout: 30000 }, async () =>
{
    await withNode(trust_test_ca, async (node) =>
    {
        await assert.rejects(node.connectService(url(impostor)), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.AuthenticationError" && /rather than/.test(e.message));
        await assert.rejects(node.connectService(url(impostor, "")), named("RobotRaconteur.AuthenticationError"));
    });
});

test("rrs+tcp is refused by a server that is not the requested node", { timeout: 30000 }, async () =>
{
    await withNode(trust_test_ca, async (node) =>
    {
        await assert.rejects(node.connectService(url(server, `nodeid=${id_of(impostor)}&`)), named("RobotRaconteur.NodeNotFound"));
    });
});

test("rr+tcp is refused by a server that requires TLS", { timeout: 30000 }, async () =>
{
    await withNode(trust_test_ca, async (node) =>
    {
        await assert.rejects(node.connectService(`rr+tcp://localhost:${server.port}?service=test_service`), named("RobotRaconteur.ConnectionError"));
    });
});

test("a client certificate is accepted by a server that trusts it", { timeout: 30000 }, async () =>
{
    const options = { ...trust_test_ca, clientCertificate: { pfx: readFileSync(client_p12) } };
    await withNode(options, async (node) =>
    {
        const c = await node.connectService(url(server));
        assert.equal(await c.callFunction("add_two_numbers", [2, 4]), 6);
    }, client_id);

    // Core checks it: a server that does not trust its issuer refuses the connection
    await withNode(options, async (node) =>
    {
        await assert.rejects(node.connectService(url(no_client_ca)));
    }, client_id);
});

test("a client certificate must be for this node", { timeout: 30000 }, async () =>
{
    const options = { ...trust_test_ca, clientCertificate: { pfx: readFileSync(client_p12) } };
    await withNode(options, async (node) =>
    {
        await assert.rejects(node.connectService(url(server)), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.AuthenticationError" && /not for this node/.test(e.message));
    });
});
