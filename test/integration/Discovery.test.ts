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
import { after, before, describe, test } from "node:test";
import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { RobotRaconteurNode } from "robotraconteur";
import { connectServiceCandidates, NodeDiscovery, TcpTransport } from "../../src/index.js";
import type { NodeDiscoveryInfo } from "../../src/index.js";
import { root, startTestServer, TestServer } from "./TestServer.js";

// Core announces over IPv6 link-local multicast by default
const has_link_local = Object.values(networkInterfaces()).flat().some((a) => a?.family === "IPv6" && a.address.startsWith("fe80"));

describe("node discovery", { skip: has_link_local ? false : "no IPv6 link-local interface" }, () =>
{
    const TYPE = "com.robotraconteur.testing.TestService1.testroot";
    const SERVICE = "RobotRaconteurTestService";

    const node = new RobotRaconteurNode();
    node.requestTimeout = 10000;
    const tcp = new TcpTransport(node);
    node.registerTransport(tcp);
    const discovery = new NodeDiscovery(node, tcp);
    let server: TestServer;
    let remote: { id: string; name: string };
    const detected: NodeDiscoveryInfo[] = [];

    before(async () =>
    {
        server = await startTestServer();
        discovery.addNodeDetectedListener((n) => detected.push(n));
        await discovery.start();

        const r = await node.connectService(`rr+tcp://localhost:${server.port}?service=${SERVICE}`);
        remote = { id: r.context.remoteNodeID.toString(), name: r.context.remoteNodeName };
        await node.disconnectService(r);
    }, { timeout: 60000 });

    after(async () =>
    {
        discovery.close();
        await node.shutdown();
        server.stop();
    });

    test("finds a service by type and connects to it", { timeout: 30000 }, async () =>
    {
        const found = await discovery.findServiceByType(TYPE);
        const s = found.find((x) => x.name === SERVICE && x.nodeID.toString() === remote.id);
        assert.ok(s, `service not found in: ${found.map((x) => x.name).join(", ")}`);
        assert.equal(s.rootObjectType, TYPE);
        assert.equal(s.nodeName, remote.name);
        assert.ok(s.connectionURLs.length > 0);

        const r = await connectServiceCandidates(node, s.connectionURLs);
        assert.equal(r.objectType, TYPE);
        await node.disconnectService(r);
    });

    test("does not report services of other types", { timeout: 30000 }, async () =>
    {
        assert.equal((await discovery.findServiceByType("com.example.NoSuchService.thing")).length, 0);
    });

    test("reports a detected node once", () =>
    {
        const matches = detected.filter((n) => n.nodeID.toString() === remote.id);
        assert.equal(matches.length, 1);
        assert.equal(matches[0]!.nodeName, remote.name);
    });

    test("finds a node by name and by NodeID", { timeout: 30000 }, async () =>
    {
        const by_name = await discovery.findNodeByName(remote.name);
        assert.ok(by_name.length > 0);
        const n = by_name[0]!;
        assert.equal(n.nodeID.toString(), remote.id);

        const by_id = await discovery.findNodeByID(n.nodeID);
        assert.equal(by_id.length, 1);
        assert.equal(by_id[0]!.nodeName, remote.name);

        const urls = n.connectionURLs.map((u) => `${u}&service=${SERVICE}`);
        const r = await connectServiceCandidates(node, urls);
        assert.equal(r.objectType, TYPE);
        await node.disconnectService(r);
    });

    test("the built package works from plain JavaScript", { timeout: 30000 }, async () =>
    {
        const { stdout } = await promisify(execFile)(process.execPath, [join(root, "examples/find_service.mjs"), TYPE, SERVICE], { timeout: 25000 });
        assert.match(stdout, new RegExp(`Found ${SERVICE} on node ${remote.name}`));
        assert.match(stdout, new RegExp(`Connected to object of type ${TYPE}`));
    });
});
