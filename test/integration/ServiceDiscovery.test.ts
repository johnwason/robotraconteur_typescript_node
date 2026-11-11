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
import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { RobotRaconteurNode, VarValue } from "robotraconteur";
import { NodeDiscovery, TcpTransport } from "../../src/index.js";
import { TEST_SERVICE_DEF, TestRoot } from "./TestService.js";
import { PYTHON, root } from "./TestServer.js";

// Nodes announce over IPv6 multicast, which needs a link-local interface
const has_link_local = Object.values(networkInterfaces()).flat().some((a) => a?.family === "IPv6" && a.address.startsWith("fe80"));

describe("discovery of services served by robotraconteur-node", { skip: has_link_local ? false : "no IPv6 link-local interface" }, () =>
{
    const TYPE = "experimental.ts_service_test.testroot";

    const server = new RobotRaconteurNode();
    server.nodeName = "ts_discovery_test";
    const server_tcp = new TcpTransport(server);
    server.registerTransport(server_tcp);
    server.registerServiceType(TEST_SERVICE_DEF);

    const client = new RobotRaconteurNode();
    client.requestTimeout = 10000;
    const client_tcp = new TcpTransport(client);
    client.registerTransport(client_tcp);
    const discovery = new NodeDiscovery(client, client_tcp);

    before(async () =>
    {
        await server_tcp.startServer(0);
        const c = server.registerService("test", TYPE, new TestRoot());
        c.attributes.set("Location", new VarValue("lab", "string"));
        // Not reported, as Core only reports strings and numeric arrays
        c.attributes.set("Nested", new VarValue(new Map([["a", new VarValue("b", "string")]]), "varvalue{string}"));
        await server_tcp.enableNodeAnnounce();
        await discovery.start();
    });

    after(async () =>
    {
        discovery.close();
        await client.shutdown();
        await server.shutdown();
    });

    test("a client finds the service by type and connects to it", { timeout: 30000 }, async () =>
    {
        let found = await discovery.findServiceByType(TYPE);
        for (let i = 0; i < 20 && !found.some((s) => s.nodeID.equals(server.nodeID)); i++)
        {
            await new Promise((r) => setTimeout(r, 500));
            found = await discovery.findServiceByType(TYPE);
        }
        const s = found.find((x) => x.nodeID.equals(server.nodeID));
        assert.ok(s, "service not found");
        assert.equal(s.name, "test");
        assert.equal(s.nodeName, "ts_discovery_test");
        assert.equal((s.attributes.get("Location") as VarValue).value, "lab");
        assert.ok(!s.attributes.has("Nested"));

        const r = await client.connectService(s.connectionURLs);
        assert.equal(await r.callFunction("add", [1, 2]), 3);
        await client.disconnectService(r);
    });

    test("the service index reports the services with the URL the client used", async () =>
    {
        const index = await client.connectService(`rr+tcp://127.0.0.1:${server_tcp.listenPort}?service=RobotRaconteurServiceIndex`);
        try
        {
            const services = await index.callFunction("GetLocalNodeServices") as Map<number, { Name: string; RootObjectType: string; ConnectionURL: Map<number, string> }>;
            const test_service = [...services.values()].find((x) => x.Name === "test")!;
            assert.equal(test_service.RootObjectType, TYPE);
            const id = server.nodeID.toString().replace(/[{}]/g, "");
            assert.equal(test_service.ConnectionURL.get(1), `rr+tcp://127.0.0.1:${server_tcp.listenPort}/?nodeid=${id}&service=test`);
            assert.ok([...services.values()].some((x) => x.Name === "RobotRaconteurServiceIndex"));
        }
        finally
        {
            await client.disconnectService(index);
        }
    });

    test("the service state nonce changes when services change", () =>
    {
        const before_nonce = server.serviceStateNonce;
        server.registerService("other", TYPE, new TestRoot());
        const registered = server.serviceStateNonce;
        assert.notEqual(registered, before_nonce);
        server.closeService("other");
        assert.notEqual(server.serviceStateNonce, registered);
    });

    test("Core's Python client finds the service by type", { timeout: 60000 }, async () =>
    {
        const script = join(root, "test/server/rr_find_service_client.py");
        const { stdout } = await promisify(execFile)(PYTHON, [script, TYPE, server.nodeID.toString()], { timeout: 50000 });
        assert.match(stdout, /^OK$/m);
    });
});
