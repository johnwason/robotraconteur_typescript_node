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
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { GeneratorHandle, RobotRaconteurError, RobotRaconteurNode, VarValue } from "robotraconteur";
import type { Endpoint, ITransportConnection, ServiceStub } from "robotraconteur";
import { isWebSocketOriginAllowed, TcpTransport } from "../../src/index.js";
import type { ServerContext } from "../../src/index.js";
import { TEST_SERVICE_DEF, TestRoot } from "./TestService.js";
import { PYTHON, root } from "./TestServer.js";

function newClientNode(): RobotRaconteurNode
{
    const n = new RobotRaconteurNode();
    n.registerTransport(new TcpTransport(n));
    return n;
}

describe("services", () =>
{
    const server = new RobotRaconteurNode();
    server.nodeName = "ts_service_test";
    const tcp = new TcpTransport(server);
    tcp.handshakeTimeout = 1000;
    server.registerTransport(tcp);
    server.registerServiceType(TEST_SERVICE_DEF);
    const obj = new TestRoot();
    let context: ServerContext;
    const client = newClientNode();

    before(async () =>
    {
        await tcp.startServer(0);
        context = server.registerService("test", "experimental.ts_service_test.testroot", obj);
        context.attributes.set("Location", new VarValue("lab", "string"));
    });

    after(async () =>
    {
        await client.shutdown();
        await server.shutdown();
    });

    const url = (scheme = "rr+tcp", service = "test") => `${scheme}://localhost:${tcp.listenPort}?service=${service}`;

    for (const scheme of ["rr+tcp", "rr+ws"])
    {
        describe(`over ${scheme}`, () =>
        {
            let c: ServiceStub;

            before(async () =>
            {
                c = await client.connectService(url(scheme));
            });

            after(async () =>
            {
                await client.disconnectService(c);
            });

            test("the client receives the object type, definitions, and attributes", () =>
            {
                assert.equal(c.objectType, "experimental.ts_service_test.testroot");
                assert.equal(c.context.remoteNodeName, "ts_service_test");
                assert.ok(c.context.remoteNodeID.equals(server.nodeID));
                assert.equal((c.context.attributes.get("Location") as VarValue).value, "lab");
                assert.equal(c.context.serviceDefForType(c.objectType).docString?.trim(), "A service for testing robotraconteur-node services");
            });

            test("properties are read and written as attributes of the object", async () =>
            {
                await c.setProperty("d1", 2.25);
                assert.equal(await c.getProperty("d1"), 2.25);
                assert.equal(obj.d1, 2.25);

                await c.setProperty("ia", Int32Array.of(4, 5));
                assert.deepEqual(await c.getProperty("ia"), Int32Array.of(4, 5));
                await c.setProperty("p1", { x: 3, y: 4 });
                assert.deepEqual({ ...(await c.getProperty("p1") as object) }, { x: 3, y: 4 });
                await c.setProperty("m1", 5);
                assert.equal(await c.getProperty("m1"), 5);
                await c.setProperty("v1", new VarValue(Float64Array.of(1, 2), "double[]"));
                const v = await c.getProperty("v1") as VarValue;
                assert.equal(v.type, "double[]");
                assert.deepEqual(v.value, Float64Array.of(1, 2));
                await c.setProperty("smap", new Map([["k", "v"]]));
                assert.deepEqual(await c.getProperty("smap"), new Map([["k", "v"]]));
            });

            test("readonly and writeonly properties are enforced", async () =>
            {
                assert.equal(await c.getProperty("s1"), obj.s1);
                await assert.rejects(c.setProperty("s1", "x"), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.ReadOnlyMember");
                await c.setProperty("w1", 7);
                assert.equal(obj.w1_value, 7);
                await assert.rejects(c.getProperty("w1"), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.WriteOnlyMember");
            });

            test("functions are methods of the object, and may be asynchronous", async () =>
            {
                assert.equal(await c.callFunction("add", [2, 3]), 5);
                assert.equal(await c.callFunction("add", { b: 10, a: 1 }), 11);
                assert.equal(await c.callFunction("add_slowly", [1, 1]), 2);
                assert.equal(await c.callFunction("set_s1", ["changed"]), undefined);
                assert.equal(obj.s1, "changed");
                assert.deepEqual({ ...(await c.callFunction("make_point", [5, 6]) as object) }, { x: 5, y: 6 });
            });

            test("errors are returned to the client", async () =>
            {
                await assert.rejects(c.callFunction("fail_rr", ["bad value"]), (e: RobotRaconteurError) =>
                {
                    assert.equal(e.errorName, "RobotRaconteur.InvalidArgument");
                    assert.equal(e.message, "bad value");
                    assert.equal(e.errorSubName, "test.sub");
                    assert.deepEqual((e.errorParam as VarValue).value, Float64Array.of(4, 5));
                    return true;
                });
                await assert.rejects(c.callFunction("fail_plain", ["oops"]), (e: RobotRaconteurError) => e.errorName === "TypeError" && e.message === "oops");
                await assert.rejects(c.getProperty("nothing"), RobotRaconteurError);
                await assert.rejects(c.peekWireInValue("w"), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.NotImplementedError");
            });

            test("events are sent to the client", async () =>
            {
                const received = new Promise<unknown[]>((resolve) => c.addEventListener("ev1", (...args: unknown[]) => resolve(args)));
                await c.callFunction("fire_event", ["hi", 2]);
                assert.deepEqual(await received, ["hi", 2]);
            });

            test("the current endpoint is known while serving a request", async () =>
            {
                assert.equal(await c.callFunction("current_endpoint"), c.context.remoteEndpoint);
                assert.ok(context.clientEndpoints.includes(c.context.remoteEndpoint));
            });

            test("generators may be iterables, async generators, or objects with Next", async () =>
            {
                const values: number[] = [];
                for await (const v of await c.callGenerator<number>("count_to", [4])) values.push(v);
                assert.deepEqual(values, [0, 1, 2, 3]);

                // A generator that has ended is destroyed, as in Core
                const g = await c.callGenerator<number>("count_to", [1]);
                assert.equal(await c.callFunctionGenNext(g), 0);
                await assert.rejects(c.callFunctionGenNext(g), (e: RobotRaconteurError) => e.isStopIteration);
                await assert.rejects(c.callFunctionGenNext(g), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.InvalidOperation");

                const s = await c.callGenerator<number>("scale", [3]);
                assert.equal(await c.callFunctionGenNext(s, 2), 6);
                assert.equal(await c.callFunctionGenNext(s, -1.5), -4.5);
                await c.callFunctionGenClose(s);
                await assert.rejects(c.callFunctionGenNext(s, 1), (e: RobotRaconteurError) => e.isStopIteration);

                const a = await c.callGenerator<number>("scale", [3]);
                await c.callFunctionGenAbort(a);
                await assert.rejects(c.callFunctionGenNext(a, 1), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.OperationAborted");

                await assert.rejects(c.callGenerator("not_a_generator"), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.InvalidOperation");
            });

            test("callbacks call the function set by the client", async () =>
            {
                await assert.rejects(c.callFunction("call_cb_add", [1, 2]), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.InvalidOperation");
                c.setCallback("cb_add", async (a: number, b: number) => a + b + 0.5);
                assert.equal(await c.callFunction("call_cb_add", [1, 2]), 3.5);
                c.setCallback("cb_add", () =>
                {
                    throw new RobotRaconteurError(18, "RobotRaconteur.InvalidArgument", "no thanks");
                });
                await assert.rejects(c.callFunction("call_cb_add", [1, 2]), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.InvalidArgument" && e.message === "no thanks");
                await assert.rejects(c.callFunction("call_cb_endpoint", [987654]), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.InvalidArgument");
            });

            test("a generator can only be used by the client that created it", async () =>
            {
                const g = await c.callGenerator<number>("count_to", [3]);
                const other = await client.connectService(url(scheme));
                try
                {
                    const stolen = new GeneratorHandle("count_to", g.index, { type: "int32" }, undefined, other);
                    await assert.rejects(other.callFunctionGenNext(stolen), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.InvalidOperation");
                    assert.equal(await c.callFunctionGenNext(g), 0);
                }
                finally
                {
                    await client.disconnectService(other);
                }
            });

            test("objrefs return objects from get_ methods, with and without indexes", async () =>
            {
                const o1 = await c.getObjRef("o1");
                assert.equal(o1.objectType, "experimental.ts_service_test.sub");
                assert.equal(await o1.getProperty("name"), "o1");
                assert.equal(await o1.callFunction("path"), "test.o1");
                assert.equal(await (await o1.getObjRef("child")).getProperty("name"), "o1.child");
                assert.equal(await (await c.getObjRef("o2", 3)).getProperty("name"), "o2 3");
                const o3 = await c.getObjRef("o3", "a.b c");
                assert.equal(await o3.getProperty("name"), "o3 a.b c");
                assert.equal(await o3.callFunction("path"), "test.o3[a%2eb%20c]");
                const o4 = await c.getObjRef("o4");
                assert.equal(o4.objectType, "experimental.ts_service_test.sub");
                await assert.rejects(c.getObjRef("missing"), (e: RobotRaconteurError) => e.errorName.startsWith("RobotRaconteur.ObjectNotFound"));
            });
        });
    }

    test("a released service path asks for the object again", async () =>
    {
        const c = await client.connectService(url());
        try
        {
            const o1 = await c.getObjRef("o1");
            const before_release = await o1.getProperty("name");
            await c.callFunction("release_o1");
            await new Promise((r) => setTimeout(r, 100));
            assert.ok(o1.released);
            await assert.rejects(o1.getProperty("name"));
            const again = await c.getObjRef("o1");
            assert.notEqual(await again.getProperty("name"), before_release);
        }
        finally
        {
            await client.disconnectService(c);
        }
    });

    test("a client that connects in separate requests is served", async () =>
    {
        // Connects with GetServiceDesc, ObjectTypeName, and ConnectClient, as clients without the
        // combined connect operation do
        class SeparateTcpTransport extends TcpTransport
        {
            override async createTransportConnection(u: string, endpoint: Endpoint): Promise<ITransportConnection>
            {
                const c = await super.createTransportConnection(u, endpoint);
                (c as { useCombinedConnection: boolean }).useCombinedConnection = false;
                return c;
            }
        }
        const n = new RobotRaconteurNode();
        n.registerTransport(new SeparateTcpTransport(n));
        try
        {
            const c = await n.connectService(url());
            assert.equal(c.objectType, "experimental.ts_service_test.testroot");
            assert.equal((c.context.attributes.get("Location") as VarValue).value, "lab");
            assert.equal(await c.callFunction("add", [20, 22]), 42);
            assert.ok(context.clientEndpoints.includes(c.context.remoteEndpoint));
            await assert.rejects(n.connectService(url("rr+tcp", "nothing")), RobotRaconteurError);
        }
        finally
        {
            await n.shutdown();
        }
    });

    test("disconnecting removes the client", async () =>
    {
        const c = await client.connectService(url());
        const ep = c.context.remoteEndpoint;
        assert.ok(context.clientEndpoints.includes(ep));
        await client.disconnectService(c);
        assert.ok(!context.clientEndpoints.includes(ep));
    });

    test("a client cannot connect to a service that does not exist", async () =>
    {
        await assert.rejects(client.connectService(url("rr+tcp", "nothing")), (e: RobotRaconteurError) => e.errorName.startsWith("RobotRaconteur.ServiceNotFound"));
    });

    test("closing a service disconnects its clients", async () =>
    {
        server.registerService("other", "experimental.ts_service_test.testroot", new TestRoot());
        const c = await client.connectService(url("rr+tcp", "other"));
        const closed = new Promise<void>((resolve) => c.context.addCloseListener(resolve));
        server.closeService("other");
        await closed;
        assert.ok(!server.registeredServiceNames.includes("other"));
    });

    test("WebSocket origins are checked as in Core", async () =>
    {
        const allowed = ["null", "file://", "https://*.robotraconteur.com:443", "http://example.com"];
        assert.ok(isWebSocketOriginAllowed("null", allowed));
        assert.ok(isWebSocketOriginAllowed("file:///home/page.html", allowed));
        assert.ok(isWebSocketOriginAllowed("https://www.robotraconteur.com:443", allowed));
        assert.ok(isWebSocketOriginAllowed("http://example.com/page", allowed));
        assert.ok(!isWebSocketOriginAllowed("http://example.org", allowed));
        assert.ok(!isWebSocketOriginAllowed("https://robotraconteur.com.evil.org:443", allowed));

        const n = new RobotRaconteurNode();
        const t = new TcpTransport(n);
        n.registerTransport(t);
        try
        {
            t.webSocketOptions = { headers: { Origin: "http://example.org" } };
            await assert.rejects(n.connectService(url("rr+ws")), /403/);
            t.webSocketOptions = { headers: { Origin: "https://robotraconteur.com" } };
            const c = await n.connectService(url("rr+ws"));
            assert.equal(await c.callFunction("add", [1, 2]), 3);
        }
        finally
        {
            await n.shutdown();
        }
    });

    test("a socket that does not start a known protocol is closed", async () =>
    {
        const result = (data: string | null) => new Promise<string>((resolve) =>
        {
            const s = netConnect(tcp.listenPort, "127.0.0.1");
            let got = "";
            s.on("data", (d) => (got += d.toString()));
            s.on("close", () => resolve(got));
            s.on("error", () => undefined);
            if (data !== null) s.write(data);
        });
        assert.match(await result("HELLO"), /404/);
        // Nothing sent at all, so the handshake times out
        assert.equal(await result(null), "");
    });

    test("Core's Python client uses the service", { timeout: 60000 }, async () =>
    {
        const script = join(root, "test/server/rr_service_test_client.py");
        const { stdout } = await promisify(execFile)(PYTHON, [script, `rr+tcp://localhost:${tcp.listenPort}?service=test`], { timeout: 50000 });
        assert.match(stdout, /^OK$/m);
    });
});
