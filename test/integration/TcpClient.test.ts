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
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect as netConnect } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createServer as createTlsServer } from "node:tls";
import { RobotRaconteurNode } from "robotraconteur";
import type { RobotRaconteurError } from "robotraconteur";
import { clientTests } from "@shared/test/common/ClientTests.js";
import { subscriptionTests, TcpProxy } from "@shared/test/common/SubscriptionTests.js";
import type { Vectors } from "@shared/test/common/ClientTests.js";
import { TcpTransport } from "../../src/index.js";
import { loadVectors, startTestServer, TestServer } from "./TestServer.js";

const vectors = loadVectors<Vectors>();
const node = new RobotRaconteurNode();
node.requestTimeout = 30000;
node.registerTransport(new TcpTransport(node));
let server: TestServer;
let proxy: TcpProxy;

before(async () =>
{
    assert.ok(process.env.RR_CORE_TEST, "RR_CORE_TEST must point at the Core test directory");
    server = await startTestServer();
    proxy = new TcpProxy(server.port);
    await proxy.start();
}, { timeout: 60000 });

after(async () =>
{
    proxy.close();
    await node.shutdown();
    server.stop();
});

test("shared client tests over rr+tcp", { timeout: 300000 }, async (t) =>
{
    for (const c of clientTests(node, server.port, vectors, "rr+tcp"))
    {
        await t.test(c.name, () => c.run());
    }
});

test("shared client tests over rr+ws", { timeout: 300000 }, async (t) =>
{
    for (const c of clientTests(node, server.port, vectors, "rr+ws"))
    {
        await t.test(c.name, () => c.run());
    }
});

test("subscriptions over rr+ws", { timeout: 120000 }, async (t) =>
{
    for (const c of subscriptionTests(node, proxy, server.port, "rr+ws", (n) => new TcpTransport(n)))
    {
        await t.test(c.name, () => c.run());
    }
});

test("rr+wss verifies the server certificate and accepts a custom certificate authority", { timeout: 60000 }, async () =>
{
    // A TLS proxy in front of the test server stands in for a server with a certificate
    const dir = mkdtempSync(join(tmpdir(), "rr_wss_"));
    const file = (n: string) => join(dir, n);
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
        "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", file("key.pem"), "-out", file("cert.pem")], { stdio: "ignore" });
    const tls_proxy = createTlsServer({ key: readFileSync(file("key.pem")), cert: readFileSync(file("cert.pem")) }, (s) =>
    {
        const upstream = netConnect(server.port, "127.0.0.1");
        s.pipe(upstream).pipe(s);
        s.on("error", () => upstream.destroy());
        upstream.on("error", () => s.destroy());
    });
    await new Promise<void>((resolve) => tls_proxy.listen(0, "127.0.0.1", resolve));
    const url = `rr+wss://localhost:${(tls_proxy.address() as AddressInfo).port}?service=RobotRaconteurTestService`;

    const n = new RobotRaconteurNode();
    const tcp = new TcpTransport(n);
    n.registerTransport(tcp);
    try
    {
        await assert.rejects(n.connectService(url), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.ConnectionError");

        tcp.webSocketOptions = { ca: readFileSync(file("cert.pem")) };
        const r = await n.connectService(url);
        assert.equal(r.objectType, "com.robotraconteur.testing.TestService1.testroot");
        await r.getProperty("d1");
    }
    finally
    {
        await n.shutdown();
        tls_proxy.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("subscriptions over rr+tcp", { timeout: 120000 }, async (t) =>
{
    for (const c of subscriptionTests(node, proxy, server.port, "rr+tcp", (n) => new TcpTransport(n)))
    {
        await t.test(c.name, () => c.run());
    }
});

test("the legacy tcp URL form connects", async () =>
{
    const r = await node.connectService(`tcp://localhost:${server.port}/{0}/RobotRaconteurTestService`.replace("{0}", (await nodeName())));
    assert.equal(r.objectType, "com.robotraconteur.testing.TestService1.testroot");
    await node.disconnectService(r);
});

async function nodeName(): Promise<string>
{
    const r = await node.connectService(`rr+tcp://localhost:${server.port}?service=RobotRaconteurTestService`);
    const name = r.context.remoteNodeName;
    await node.disconnectService(r);
    return name;
}
