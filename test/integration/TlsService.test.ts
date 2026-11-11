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

// rrs+tcp services: STARTTLS on the server with a node certificate from a certificate authority
// made for the test, mutual authentication, RequireTls, and clients verified by the authenticator.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { NodeID, RobotRaconteurNode, VarValue } from "robotraconteur";
import type { RobotRaconteurError } from "robotraconteur";
import { PasswordFileUserAuthenticator, ServerEndpoint, ServiceSecurityPolicy, TcpTransport } from "../../src/index.js";
import type { TlsClientOptions } from "../../src/index.js";
import { TestCertificates } from "../common/TestCertificates.js";
import { PYTHON, root } from "./TestServer.js";

const DEF = `service experimental.tls_service_test

object testobj
    function int32 add(int32 a, int32 b)
    function bool secure()
    function string peer_identity()
end
`;

describe("rrs+tcp services", () =>
{
    const certs = new TestCertificates();
    const ca = certs.root();
    const intermediate = certs.intermediate(ca);
    const trust: TlsClientOptions = { trustedRoots: [ca.pem], useDefaultRoots: false };

    /** A node certificate for a node, from the test authority, as PKCS#12 */
    const nodeCert = (id: NodeID, name: string, dir = certs.dir) =>
    {
        const file = join(dir, "certificates", id.toString() + ".p12");
        certs.pkcs12(certs.node(intermediate, id.toString(), name), [intermediate], file);
        return { pfx: readFileSync(file), file };
    };

    const server = new RobotRaconteurNode();
    server.nodeName = "ts_tls_service";
    const tcp = new TcpTransport(server);
    server.registerTransport(tcp);
    server.registerServiceType(DEF);

    class TestObj
    {
        add(a: number, b: number): number
        {
            return a + b;
        }

        secure(): boolean
        {
            return tcp.isTransportConnectionSecure(ServerEndpoint.current!);
        }

        peer_identity(): string
        {
            const ep = ServerEndpoint.current!;
            return tcp.isSecurePeerIdentityVerified(ep) ? tcp.getSecurePeerIdentity(ep) : "";
        }
    }

    const client_id = NodeID.newUniqueID();
    let client_cert: { pfx: Buffer; file: string };

    before(async () =>
    {
        tcp.tlsOptions = { ...trust, clientCertificate: { pfx: nodeCert(server.nodeID, "server").pfx } };
        client_cert = nodeCert(client_id, "client", join(certs.dir, "client"));
        await tcp.startServer(0);
        server.registerService("tls", "experimental.tls_service_test.testobj", new TestObj());
        const users = `user1 ${PasswordFileUserAuthenticator.md5Hash("pass1")} _ ${client_id.toString()}\nuser2 ${PasswordFileUserAuthenticator.md5Hash("pass2")} _`;
        server.registerService("verified", "experimental.tls_service_test.testobj", new TestObj(),
            new ServiceSecurityPolicy(new PasswordFileUserAuthenticator(users, true), { requirevaliduser: "true" }));
    });

    after(async () =>
    {
        await server.shutdown();
        certs.close();
    });

    const id = server.nodeID.toString().slice(1, -1);
    const url = (service = "tls", scheme = "rrs+tcp") => `${scheme}://localhost:${tcp.listenPort}?nodeid=${id}&service=${service}`;

    async function withClient<T>(options: TlsClientOptions, fn: (node: RobotRaconteurNode, t: TcpTransport) => Promise<T>, node_id?: NodeID): Promise<T>
    {
        const node = new RobotRaconteurNode();
        if (node_id) node.nodeID = node_id;
        const t = new TcpTransport(node);
        t.tlsOptions = options;
        node.registerTransport(t);
        try
        {
            return await fn(node, t);
        }
        finally
        {
            await node.shutdown();
        }
    }

    test("a client connects with rrs+tcp and checks the service's node certificate", async () =>
    {
        await withClient(trust, async (node, t) =>
        {
            const c = await node.connectService(url());
            assert.equal(await c.callFunction("add", [2, 3]), 5);
            assert.equal(await c.callFunction("secure"), true);
            assert.equal(t.isTransportConnectionSecure(c), true);
            assert.equal(t.getSecurePeerIdentity(c), server.nodeID.toString());
            // The client did not ask the service to check it
            assert.equal(await c.callFunction("peer_identity"), "");
        });
    });

    test("with mutual authentication, the service verifies the client's node ID", async () =>
    {
        await withClient({ ...trust, clientCertificate: { pfx: client_cert.pfx } }, async (node) =>
        {
            const c = await node.connectService(url());
            assert.equal(await c.callFunction("peer_identity"), client_id.toString());
        }, client_id);
    });

    test("plain connections still work unless TLS is required", async () =>
    {
        await withClient({}, async (node) =>
        {
            const c = await node.connectService(url("tls", "rr+tcp"));
            assert.equal(await c.callFunction("secure"), false);
            await node.disconnectService(c);

            tcp.requireTls = true;
            try
            {
                await assert.rejects(node.connectService(url("tls", "rr+tcp")));
            }
            finally
            {
                tcp.requireTls = false;
            }
        });
        tcp.requireTls = true;
        try
        {
            await withClient(trust, async (node) =>
            {
                const c = await node.connectService(url());
                assert.equal(await c.callFunction("secure"), true);
            });
        }
        finally
        {
            tcp.requireTls = false;
        }
    });

    test("a service without a node certificate refuses rrs+tcp", async () =>
    {
        const other = new RobotRaconteurNode();
        const other_tcp = new TcpTransport(other);
        other.registerTransport(other_tcp);
        other.registerServiceType(DEF);
        await other_tcp.startServer(0);
        other.registerService("tls", "experimental.tls_service_test.testobj", new TestObj());
        try
        {
            await withClient(trust, async (node) =>
            {
                await assert.rejects(node.connectService(`rrs+tcp://localhost:${other_tcp.listenPort}?service=tls`), (e: RobotRaconteurError) => e.message.includes("Server certificate not loaded"));
            });
        }
        finally
        {
            await other.shutdown();
        }
    });

    test("users may only log in from verified clients with an allowed node ID", async () =>
    {
        const password = (p: string) => new Map([["password", new VarValue(p, "string")]]);
        await withClient({ ...trust, clientCertificate: { pfx: client_cert.pfx } }, async (node) =>
        {
            const c = await node.connectService(url("verified"), "user1", password("pass1"));
            assert.equal(await c.callFunction("add", [1, 1]), 2);
            await node.disconnectService(c);
            // user2 has no allowed node IDs, so any verified client may log in as it
            const c2 = await node.connectService(url("verified"), "user2", password("pass2"));
            await node.disconnectService(c2);
        }, client_id);

        // Not verified: no client certificate
        await withClient(trust, async (node) =>
        {
            await assert.rejects(node.connectService(url("verified"), "user1", password("pass1")));
        });

        // Verified, but not a node ID user1 may log in from
        const other_id = NodeID.newUniqueID();
        const other_cert = nodeCert(other_id, "other_client", join(certs.dir, "other_client"));
        await withClient({ ...trust, clientCertificate: { pfx: other_cert.pfx } }, async (node) =>
        {
            await assert.rejects(node.connectService(url("verified"), "user1", password("pass1")));
            const c = await node.connectService(url("verified"), "user2", password("pass2"));
            await node.disconnectService(c);
        }, other_id);
    });

    // Core uses Schannel on Windows, which takes trusted roots from the certificate store instead
    // of ROBOTRACONTEUR_SSL_CERT_FILE
    test("Core's Python client uses the service over rrs+tcp", { skip: process.platform === "win32" ? "Schannel ignores ROBOTRACONTEUR_SSL_CERT_FILE" : false, timeout: 60000 }, async () =>
    {
        const script = join(root, "test/server/rr_tls_service_client.py");
        const run = (...args: string[]) => promisify(execFile)(PYTHON, [script, url(), ca.certFile, ...args], { timeout: 50000 });

        const anonymous = await run();
        assert.match(anonymous.stdout, /^IDENTITY $/m);
        assert.match(anonymous.stdout, /^OK$/m);

        const py_id = NodeID.newUniqueID();
        const config = join(certs.dir, "python");
        nodeCert(py_id, "python", config);
        const verified = await run(config, py_id.toString());
        assert.ok(verified.stdout.includes(`IDENTITY ${py_id.toString()}\n`), verified.stdout);
        assert.match(verified.stdout, /^OK$/m);
    });
});
