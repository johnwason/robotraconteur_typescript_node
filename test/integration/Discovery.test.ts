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
import { createServiceSubscriptionFilterAttributeRegex, NodeDiscovery, ServiceSubscriptionFilterAttribute, ServiceSubscriptionFilterAttributeGroup, TcpTransport } from "../../src/index.js";
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

        const r = await node.connectService(s.connectionURLs);
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
        const r = await node.connectService(urls);
        assert.equal(r.objectType, TYPE);
        await node.disconnectService(r);
    });

    const until = async (condition: () => boolean, what: string) =>
    {
        const deadline = Date.now() + 20000;
        while (!condition())
        {
            if (Date.now() > deadline) throw new Error("Timed out waiting for " + what);
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    };

    test("a subscription by type connects and keeps the service connected", { timeout: 40000 }, async () =>
    {
        const s = discovery.subscribeServiceByType(TYPE, { serviceNames: [SERVICE] });
        s.connectRetryDelay = 50;
        try
        {
            const first = await s.getDefaultClientWait(20000);
            assert.equal(first.objectType, TYPE);
            assert.equal(s.getConnectedClients().length, 1, "only the named service should connect");
            assert.equal(s.getConnectedClients()[0]!.serviceName, SERVICE);

            const w = s.subscribeWire("w1");
            await until(() => w.activeConnectionCount === 1, "wire connection");

            await node.disconnectService(first);
            await until(() => s.tryGetDefaultClient() !== null && s.tryGetDefaultClient() !== first, "reconnection");
            await until(() => w.activeConnectionCount === 1, "wire to reconnect");
            w.setOutValueAll(Float64Array.of(42));
            assert.ok(await w.waitInValueValid(20000));
        }
        finally
        {
            s.close();
        }
    });

    test("subscription filters limit the services used", { timeout: 40000 }, async () =>
    {
        const options = [
            { nodes: [{ nodeName: "no_such_node" }], serviceNames: [SERVICE] },
            { serviceNames: ["no_such_service"] },
            { predicate: () => false },
            { transportSchemes: ["rr+nothing"] }
        ];
        const subs = options.map((o) => discovery.subscribeServiceByType(TYPE, o));
        const matching = discovery.subscribeServiceByType(TYPE, { nodes: [{ nodeName: remote.name }], serviceNames: [SERVICE], predicate: (i) => i.name === SERVICE });
        try
        {
            await matching.getDefaultClientWait(20000);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            for (const s of subs) assert.equal(s.getConnectedClients().length, 0);
        }
        finally
        {
            [...subs, matching].forEach((s) => s.close());
        }
    });

    test("attribute filters use the attributes reported by the service", { timeout: 40000 }, async () =>
    {
        const group = (...a: ServiceSubscriptionFilterAttribute[]) => new ServiceSubscriptionFilterAttributeGroup("or", a);
        const exact = new ServiceSubscriptionFilterAttribute("This is a test attribute");
        type Conditions = Record<string, ServiceSubscriptionFilterAttributeGroup>;
        const subscribe = (attributes: Conditions) => discovery.subscribeServiceByType(TYPE, { serviceNames: [SERVICE], attributes });
        const matching = ([
            { test: group(exact) },
            { test: group(createServiceSubscriptionFilterAttributeRegex("This is .* attribute")) },
            { missing_attribute: new ServiceSubscriptionFilterAttributeGroup("nor", [exact]) }
        ] as Conditions[]).map(subscribe);
        const excluded = ([
            { test: group(new ServiceSubscriptionFilterAttribute("Some other value")) },
            { test: group(createServiceSubscriptionFilterAttributeRegex("is a test")) },
            // A numeric attribute cannot match a string
            { test2: group(new ServiceSubscriptionFilterAttribute("42")) },
            { missing_attribute: group(exact) }
        ] as Conditions[]).map(subscribe);
        try
        {
            for (const s of matching) await s.getDefaultClientWait(20000);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            for (const s of excluded) assert.equal(s.getConnectedClients().length, 0);
        }
        finally
        {
            [...matching, ...excluded].forEach((s) => s.close());
        }
    });

    test("a subscription can be limited to one connection", { timeout: 40000 }, async () =>
    {
        const s = discovery.subscribeServiceByType(TYPE, { maxConnections: 1 });
        s.connectRetryDelay = 50;
        try
        {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            assert.ok(s.getConnectedClients().length <= 1);
        }
        finally
        {
            s.close();
        }
    });

    test("a type subscription needs discovery to be started", () =>
    {
        const n = new NodeDiscovery(node, tcp);
        assert.throws(() => n.subscribeServiceByType(TYPE));
    });

    test("service information subscriptions report detected and lost services", { timeout: 40000 }, async () =>
    {
        // A separate node, so that expiring its nodes does not affect the other tests
        const n2 = new RobotRaconteurNode();
        const t2 = new TcpTransport(n2);
        n2.registerTransport(t2);
        const d2 = new NodeDiscovery(n2, t2, { nodeExpiration: 2500 });
        await d2.start();
        try
        {
            const s = d2.subscribeServiceInfo2(TYPE, { serviceNames: [SERVICE] });
            const detected_names: string[] = [];
            const lost_names: string[] = [];
            s.addServiceDetectedListener((_, i) => detected_names.push(i.name));
            s.addServiceLostListener((_, i) => lost_names.push(i.name));

            await until(() => detected_names.includes(SERVICE), "service to be detected");
            assert.deepEqual(s.getDetectedServiceInfo2().map((i) => i.name), [SERVICE]);
            assert.equal(s.getDetectedServiceInfo2()[0]!.rootObjectType, TYPE);

            // Nothing is requested after this, so the node expires before it next announces
            await until(() => lost_names.includes(SERVICE), "service to be lost");
            assert.deepEqual(s.getDetectedServiceInfo2(), []);
            s.close();
        }
        finally
        {
            d2.close();
            await n2.shutdown();
        }
    });

    test("the built package works from plain JavaScript", { timeout: 30000 }, async () =>
    {
        const { stdout } = await promisify(execFile)(process.execPath, [join(root, "examples/find_service.mjs"), TYPE, SERVICE], { timeout: 25000 });
        assert.match(stdout, new RegExp(`Found ${SERVICE} on node ${remote.name}`));
        assert.match(stdout, new RegExp(`Connected to object of type ${TYPE}`));
    });
});
