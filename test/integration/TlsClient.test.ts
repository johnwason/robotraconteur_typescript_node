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
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { NodeID, RobotRaconteurNode } from "robotraconteur";
import type { RobotRaconteurError } from "robotraconteur";
import { TcpTransport } from "../../src/index.js";
import type { TlsClientOptions } from "../../src/index.js";
import { TlsTestServers } from "./TlsServer.js";
import type { TlsTestServer } from "./TlsServer.js";

// rrs+tcp against Core TLS servers, using a certificate authority made for the test

const tls = new TlsTestServers();
const { certs, ca, intermediate } = tls;

// On Windows, Core usually uses Schannel, which finds a node's certificate in the certificate store
// by the node's own ID, and trusts certificate authorities for every server at once. So a server
// presenting another node's certificate, or one that trusts a different authority from the others,
// cannot be made there
const schannel = process.platform === "win32";

let server: TlsTestServer;
let impostor: TlsTestServer;
let no_client_ca: TlsTestServer;

before(async () =>
{
    server = await tls.start("server");
    if (!schannel)
    {
        impostor = await tls.start("impostor", NodeID.newUniqueID(), NodeID.newUniqueID());
        no_client_ca = await tls.start("no_client_ca", NodeID.newUniqueID(), NodeID.Any, false);
    }
}, { timeout: 60000 });

after(() => tls.close());

const trust_test_ca: TlsClientOptions = { trustedRoots: [ca.pem], useDefaultRoots: false };
const id_of = (s: TlsTestServer) => s.id.toString().slice(1, -1);
const url = (s: TlsTestServer, query = `nodeid=${id_of(s)}&`) => `rrs+tcp://localhost:${s.port}?${query}service=test_service`;

async function withNode<T>(options: TlsClientOptions, fn: (node: RobotRaconteurNode, tcp: TcpTransport) => Promise<T>, node_id?: NodeID): Promise<T>
{
    const node = new RobotRaconteurNode();
    if (node_id) node.nodeID = node_id;
    const tcp = new TcpTransport(node);
    tcp.tlsOptions = options;
    node.registerTransport(tcp);
    try
    {
        return await fn(node, tcp);
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

test("rrs+tcp refuses a server whose certificate is for another node", { timeout: 30000, skip: schannel && "Schannel cannot present another node's certificate" }, async () =>
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
        const other = NodeID.newUniqueID().toString().slice(1, -1);
        await assert.rejects(node.connectService(url(server, `nodeid=${other}&`)), named("RobotRaconteur.NodeNotFound"));
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
    if (schannel) return;
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

test("the transport reports a secure connection and the verified node", { timeout: 30000 }, async () =>
{
    await withNode(trust_test_ca, async (node, tcp) =>
    {
        const c = await node.connectService(url(server, ""));
        assert.ok(tcp.isTransportConnectionSecure(c));
        assert.ok(tcp.isSecurePeerIdentityVerified(c));
        assert.equal(tcp.getSecurePeerIdentity(c), server.id.toString());
    });
});

test("requireTls only allows rrs+tcp", { timeout: 30000 }, async () =>
{
    await withNode(trust_test_ca, async (node, tcp) =>
    {
        tcp.requireTls = true;
        await assert.rejects(node.connectService(`rr+tcp://localhost:${server.port}?service=test_service`), /TLS is required/);
        await assert.rejects(node.connectService(`rr+ws://localhost:${server.port}?service=test_service`), /TLS is required/);
        const c = await node.connectService(url(server));
        assert.equal(await c.callFunction("add_two_numbers", [2, 4]), 6);
    });
});

/** Set environment variables while running fn, then restore them */
async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void>
{
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try
    {
        await fn();
    }
    finally
    {
        for (const [k, v] of Object.entries(saved))
        {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

test("the node certificate is loaded from Core's configuration folder", { timeout: 30000 }, async () =>
{
    const config = join(certs.dir, "client_config");
    mkdirSync(join(config, "certificates"), { recursive: true });
    copyFileSync(client_p12, join(config, "certificates", client_id.toString() + ".p12"));
    // Core uses the system folder when running as root, as in the test container
    await withEnv({ ROBOTRACONTEUR_USER_CONFIG_DIR: config, ROBOTRACONTEUR_SYSTEM_CONFIG_DIR: config }, async () =>
    {
        await withNode(trust_test_ca, async (node, tcp) =>
        {
            assert.ok(!tcp.isTlsNodeCertificateLoaded);
            tcp.loadTlsNodeCertificate();
            assert.ok(tcp.isTlsNodeCertificateLoaded);
            const c = await node.connectService(url(server));
            assert.equal(await c.callFunction("add_two_numbers", [2, 4]), 6);
        }, client_id);

        await withNode(trust_test_ca, async (_node, tcp) =>
        {
            assert.throws(() => tcp.loadTlsNodeCertificate(), /Could not load node certificate/);
        });
    });
});

test("Core's certificate file and folder variables add trusted roots", { timeout: 30000 }, async () =>
{
    const connect = () => withNode({ useDefaultRoots: false }, async (node) =>
    {
        const c = await node.connectService(url(server));
        assert.equal(await c.callFunction("add_two_numbers", [2, 4]), 6);
    });
    await assert.rejects(connect(), /not issued by a trusted/);
    await withEnv({ ROBOTRACONTEUR_SSL_CERT_FILE: ca.certFile }, connect);

    const dir = join(certs.dir, "ca_dir");
    mkdirSync(dir, { recursive: true });
    copyFileSync(ca.certFile, join(dir, "site-root.pem"));
    await withEnv({ ROBOTRACONTEUR_SSL_CERT_DIR: dir }, connect);
});
