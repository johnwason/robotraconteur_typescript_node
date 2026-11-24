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
import { GeneratorHandle, NamedArrayView, newNamedArrayView, NodeID, NodeID as RRNodeID, RobotRaconteurError, RobotRaconteurNode, VarValue } from "robotraconteur";
import { DataTypes, deserializeMessage, Message, MessageElement, MessageEntry, MessageEntryType, MessageErrorType, serializeMessage, TransportCapabilityCode } from "robotraconteur/internal";
import type { Endpoint, ITransportConnection, ServiceStub } from "robotraconteur";
import * as rri from "robotraconteur/internal";
import { DEFAULT_WEBSOCKET_ALLOWED_ORIGINS, isWebSocketOriginAllowed, PasswordFileUserAuthenticator, ServiceSecurityPolicy, TcpTransport } from "../../src/index.js";
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
                assert.equal(await c.callFunction("change_s1", ["changed"]), undefined);
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

            test("wires send values with WireBroadcaster and receive them with WireUnicastReceiver", async () =>
            {
                const named = (name: string) => (e: RobotRaconteurError) => e.errorName === "RobotRaconteur." + name;
                await c.callFunction("reset_wires");
                await assert.rejects(c.peekWireInValue("w"), named("ValueNotSet"));
                await c.callFunction("change_w", [2.5]);
                assert.equal((await c.peekWireInValue("w")).value, 2.5);
                await assert.rejects(c.pokeWireOutValue("w", 1), named("ReadOnlyMember"));

                // A client that connects receives the current value, then each new one
                const w = await c.connectWire("w");
                assert.ok(await c.waitWireInValueValid(w, 5000));
                assert.equal(c.getWireInValue(w).value, 2.5);
                const next = new Promise<unknown>((resolve) => c.addWireValueChangedListener(w, (_h, v) => resolve(v)));
                await c.callFunction("change_w", [3.5]);
                assert.equal(await next, 3.5);
                await c.closeWire(w);

                await assert.rejects(c.callFunction("read_wpoke"), named("ValueNotSet"));
                await assert.rejects(c.peekWireInValue("wpoke"), named("WriteOnlyMember"));
                await c.pokeWireOutValue("wpoke", 4);
                assert.equal(await c.callFunction("read_wpoke"), 4);
                assert.equal((await c.peekWireOutValue("wpoke")).value, 4);
                const wp = await c.connectWire("wpoke");
                c.setWireOutValue(wp, 5);
                await new Promise((r) => setTimeout(r, 200));
                assert.equal(await c.callFunction("read_wpoke"), 5);
                await c.closeWire(wp);
            });

            test("pipe endpoints get indexes as in Core, and the service can close them", async () =>
            {
                const p1 = await c.connectPipe("pp");
                const p2 = await c.connectPipe("pp");
                assert.deepEqual([c.getPipeIndex(p1), c.getPipeIndex(p2)], [1, 2]);
                // Core moves a requested index past the ones the client already uses
                const p3 = await c.connectPipe("pp", 2);
                assert.equal(c.getPipeIndex(p3), 3);
                await c.sendPipePacket(p1, 21);
                assert.equal(await c.receivePipePacketWait(p1, 5000), 42);

                const closed = new Promise<void>((resolve) => c.setPipeCloseCallback(p2, () => resolve()));
                assert.equal(await c.callFunction("close_pipes"), 3);
                await closed;
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

    test("services receive arrays of named arrays as views when decodeOptions is set", async () =>
    {
        const c = await client.connectService(url());
        const vecs = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
        try
        {
            assert.equal(await c.callFunction("sum_x", [vecs]), 4);
            assert.equal(await c.callFunction("received_view"), false);

            context.decodeOptions = { viewTypes: ["experimental.ts_service_test.vec"] };
            assert.equal(await c.callFunction("sum_x", [vecs]), 4);
            assert.equal(await c.callFunction("received_view"), true);
            // The view the property received is sent back as it is
            await c.setProperty("vecs", vecs);
            assert.equal(await c.callFunction("received_view"), true);
            assert.deepEqual(await c.getProperty("vecs"), vecs);
        }
        finally
        {
            context.decodeOptions = undefined;
            await client.disconnectService(c);
        }
    });

    test("services send views made with newNamedArrayView", async () =>
    {
        const c = await client.connectService(url());
        try
        {
            assert.deepEqual(await c.callFunction("make_vecs", [2]), [{ x: 0, y: 10 }, { x: 1, y: 11 }]);
            c.context.decodeOptions = { namedArrays: "view" };
            const v = await c.callFunction("make_vecs", [3]);
            assert.ok(v instanceof NamedArrayView);
            assert.deepEqual(v.array, Float64Array.of(0, 10, 1, 11, 2, 12));
            // And clients send views
            assert.equal(await c.callFunction("sum_x", [newNamedArrayView(c, "experimental.ts_service_test.vec", Float64Array.of(5, 0, 6, 0))]), 11);
            assert.throws(() => context.newNamedArrayView("experimental.ts_service_test.point", 1), RobotRaconteurError);
        }
        finally
        {
            await client.disconnectService(c);
        }
    });

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

    test("events are not sent to clients that have not logged in to a service that requires one", async () =>
    {
        // A client that connects in separate requests is connected before it logs in, as in Core
        // ServerContext::SendEvent, which skips clients without an authenticated user
        class SeparateTcpTransport extends TcpTransport
        {
            override async createTransportConnection(u: string, endpoint: Endpoint): Promise<ITransportConnection>
            {
                const c = await super.createTransportConnection(u, endpoint);
                (c as { useCombinedConnection: boolean }).useCombinedConnection = false;
                return c;
            }
        }
        const auth_obj = new TestRoot();
        const users = `user1 ${PasswordFileUserAuthenticator.md5Hash("pass1")} _`;
        const auth_context = server.registerService("test_auth", "experimental.ts_service_test.testroot", auth_obj,
            new ServiceSecurityPolicy(new PasswordFileUserAuthenticator(users), { requirevaliduser: "true" }));
        const n = new RobotRaconteurNode();
        n.registerTransport(new SeparateTcpTransport(n));
        try
        {
            const anon = await n.connectService(url("rr+tcp", "test_auth"));
            const user = await client.connectService(url("rr+tcp", "test_auth"), "user1", { password: new VarValue("pass1", "string") });
            assert.equal(auth_context.clientEndpoints.length, 2);
            const anon_events: unknown[][] = [];
            anon.addEventListener("ev1", (...args: unknown[]) => anon_events.push(args));
            const received = new Promise<unknown[]>((resolve) => user.addEventListener("ev1", (...args: unknown[]) => resolve(args)));
            auth_obj.ev1.fire("secret", 1);
            assert.deepEqual(await received, ["secret", 1]);
            await new Promise((r) => setTimeout(r, 200));
            assert.deepEqual(anon_events, []);
            await client.disconnectService(user);
        }
        finally
        {
            await n.shutdown();
            server.closeService("test_auth");
        }
    });

    test("a client lock is released when its client disconnects after logging out", async () =>
    {
        // As Core: client locks are released by endpoint, not by the endpoint's current user
        const users = `user1 ${PasswordFileUserAuthenticator.md5Hash("pass1")} objectlock`;
        const lock_context = server.registerService("test_lock_logout", "experimental.ts_service_test.testroot", new TestRoot(),
            new ServiceSecurityPolicy(new PasswordFileUserAuthenticator(users), { requirevaliduser: "true", allowobjectlock: "true" }));
        try
        {
            const c = await client.connectService(url("rr+tcp", "test_lock_logout"), "user1", { password: new VarValue("pass1", "string") });
            const o1 = await c.getObjRef("o1");
            await client.requestObjectLock(o1, "client");
            assert.equal(await lock_context.getObjectLockUsername("test_lock_logout.o1"), "user1");
            lock_context.getClient(c.context.remoteEndpoint)!.logoutUser();
            await client.disconnectService(c);
            assert.equal(await lock_context.getObjectLockUsername("test_lock_logout.o1"), "");
        }
        finally
        {
            server.closeService("test_lock_logout");
        }
    });

    test("another client of the same user cannot release a client lock", async () =>
    {
        const users = `user1 ${PasswordFileUserAuthenticator.md5Hash("pass1")} objectlock`;
        const lock_context = server.registerService("test_lock_session", "experimental.ts_service_test.testroot", new TestRoot(),
            new ServiceSecurityPolicy(new PasswordFileUserAuthenticator(users), { requirevaliduser: "true", allowobjectlock: "true" }));
        const n = newClientNode();
        try
        {
            const credentials = { password: new VarValue("pass1", "string") };
            const c1 = await client.connectService(url("rr+tcp", "test_lock_session"), "user1", credentials);
            const c2 = await n.connectService(url("rr+tcp", "test_lock_session"), "user1", credentials);
            const o1 = await c1.getObjRef("o1");
            const o1_2 = await c2.getObjRef("o1");
            await client.requestObjectLock(o1, "client");
            await assert.rejects(n.releaseObjectLock(o1_2), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.ObjectLockedError");
            assert.equal(await lock_context.getObjectLockUsername("test_lock_session.o1"), "user1");
            await client.releaseObjectLock(o1);
            assert.equal(await lock_context.getObjectLockUsername("test_lock_session.o1"), "");
            await client.disconnectService(c1);
        }
        finally
        {
            await n.shutdown();
            server.closeService("test_lock_session");
        }
    });

    test("clients that have not logged in cannot monitor-lock objects of a service that requires a user", async () =>
    {
        // A client that connects in separate requests is connected before it logs in
        class SeparateTcpTransport extends TcpTransport
        {
            override async createTransportConnection(u: string, endpoint: Endpoint): Promise<ITransportConnection>
            {
                const c = await super.createTransportConnection(u, endpoint);
                (c as { useCombinedConnection: boolean }).useCombinedConnection = false;
                return c;
            }
        }
        const users = `user1 ${PasswordFileUserAuthenticator.md5Hash("pass1")} _`;
        server.registerService("test_monitor_auth", "experimental.ts_service_test.testroot", new TestRoot(),
            new ServiceSecurityPolicy(new PasswordFileUserAuthenticator(users), { requirevaliduser: "true" }));
        const n = new RobotRaconteurNode();
        n.registerTransport(new SeparateTcpTransport(n));
        try
        {
            const anon = await n.connectService(url("rr+tcp", "test_monitor_auth"));
            await assert.rejects(n.monitorEnter(anon, 1000), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.PermissionDenied");
            const user = await client.connectService(url("rr+tcp", "test_monitor_auth"), "user1", { password: new VarValue("pass1", "string") });
            await client.monitorEnter(user, 1000);
            await client.monitorExit(user);
            await client.disconnectService(user);
        }
        finally
        {
            await n.shutdown();
            server.closeService("test_monitor_auth");
        }
    });

    test("objects can be locked only if the allowobjectlock policy is set", async () =>
    {
        const users = `user1 ${PasswordFileUserAuthenticator.md5Hash("pass1")} objectlock`;
        const credentials = { password: new VarValue("pass1", "string") };
        for (const allow of [false, true])
        {
            const name = allow ? "test_lock_allowed" : "test_lock_not_allowed";
            server.registerService(name, "experimental.ts_service_test.testroot", new TestRoot(),
                new ServiceSecurityPolicy(new PasswordFileUserAuthenticator(users), allow ? { requirevaliduser: "true", allowobjectlock: "true" } : { requirevaliduser: "true" }));
            try
            {
                const c = await client.connectService(url("rr+tcp", name), "user1", credentials);
                const o1 = await c.getObjRef("o1");
                if (allow)
                {
                    await client.requestObjectLock(o1, "client");
                    await client.releaseObjectLock(o1);
                }
                else
                {
                    for (const flags of ["user", "client"] as const)
                    {
                        await assert.rejects(client.requestObjectLock(o1, flags), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.PermissionDenied");
                    }
                }
                await client.disconnectService(c);
            }
            finally
            {
                server.closeService(name);
            }
        }
    });

    test("a generator the client did not close is aborted when it is destroyed", async () =>
    {
        let finish = () => {};
        const finished = new Promise<void>((resolve) => (finish = resolve));
        class GenRoot extends TestRoot
        {
            override async *count_to(n: number): AsyncGenerator<number>
            {
                try
                {
                    for (let i = 0; i < n; i++) yield i;
                }
                finally
                {
                    finish();
                }
            }
        }
        const gen_context = server.registerService("test_gen_drop", "experimental.ts_service_test.testroot", new GenRoot());
        try
        {
            const c = await client.connectService(url("rr+tcp", "test_gen_drop"));
            const g = await c.callGenerator<number>("count_to", [5]);
            assert.equal(await c.callFunctionGenNext(g), 0);
            // The generator expires without the client closing it
            (await gen_context.getObjectSkel("test_gen_drop")).cleanupGenerators(Date.now() + 3600000);
            const ran = await Promise.race([finished.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 5000))]);
            assert.ok(ran, "the generator's finally block ran");
            await client.disconnectService(c);
        }
        finally
        {
            server.closeService("test_gen_drop");
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

    test("a connection cannot disconnect a client that uses another connection", async () =>
    {
        const n = newClientNode();
        try
        {
            const c1 = await client.connectService(url());
            const c2 = await n.connectService(url());
            const m = new Message();
            m.header.senderNodeID = n.nodeID;
            m.header.receiverNodeID = server.nodeID;
            m.header.senderEndpoint = c2.context.localEndpoint;
            m.header.receiverEndpoint = c1.context.remoteEndpoint;
            const e = new MessageEntry(MessageEntryType.DisconnectClient, "");
            e.requestID = 1000;
            e.addElement(MessageElement.string("servicename", "test"));
            m.entries.push(e);
            c2.context.transportConnection!.sendMessage(m);
            // Requests on one connection are served in order, so the DisconnectClient has been handled
            assert.equal(await c2.callFunction("add", [1, 2]), 3);
            assert.ok(context.clientEndpoints.includes(c1.context.remoteEndpoint));
            assert.equal(await c1.callFunction("add", [2, 3]), 5);
            await client.disconnectService(c1);
        }
        finally
        {
            await n.shutdown();
        }
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

    test("default WebSocket origins allow local files but not every extension or plain http", async () =>
    {
        for (const o of ["chrome-extension://abcdef", "http://robotraconteur.com", "http://www.robotraconteur.com:80"])
        {
            assert.ok(!isWebSocketOriginAllowed(o, DEFAULT_WEBSOCKET_ALLOWED_ORIGINS), o);
        }
        for (const o of ["null", "file://", "https://robotraconteur.com", "https://www.robotraconteur.com:443"])
        {
            assert.ok(isWebSocketOriginAllowed(o, DEFAULT_WEBSOCKET_ALLOWED_ORIGINS), o);
        }

        // A page loaded from a local file (Origin: null) connects to the test service with the defaults
        const n = new RobotRaconteurNode();
        const t = new TcpTransport(n);
        n.registerTransport(t);
        try
        {
            t.webSocketOptions = { headers: { Origin: "null" } };
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

    test("a second CreateConnection cannot change the NodeID of a connection", async () =>
    {
        // As in Core, the NodeID is only set while it is Any or unchanged
        const s = netConnect(tcp.listenPort, "127.0.0.1");
        s.on("error", () => undefined);
        await new Promise((r) => s.once("connect", r));
        const replies: Message[] = [];
        let pending = Buffer.alloc(0);
        let wake = () => {};
        s.on("data", (d: Buffer) =>
        {
            pending = Buffer.concat([pending, d]);
            while (pending.length >= 8 && pending.length >= pending.readUInt32LE(4))
            {
                const n = pending.readUInt32LE(4);
                replies.push(deserializeMessage(new Uint8Array(pending.subarray(0, n))));
                pending = pending.subarray(n);
            }
            wake();
        });
        const createConnection = async (id: NodeID) =>
        {
            const m = new Message();
            m.header.senderNodeID = id;
            const e = new MessageEntry(MessageEntryType.StreamOp, "CreateConnection");
            e.addElement(new MessageElement("capabilities", DataTypes.uint32_t, Uint32Array.of((TransportCapabilityCode.Message2BasicPage | TransportCapabilityCode.Message2BasicEnable) >>> 0)));
            m.entries.push(e);
            s.write(serializeMessage(m));
            while (replies.length === 0) await new Promise<void>((r) => (wake = r));
            return replies.shift()!.entries[0]!.error;
        };
        try
        {
            const id = NodeID.newUniqueID();
            assert.equal(await createConnection(id), MessageErrorType.None);
            assert.equal(await createConnection(id), MessageErrorType.None);
            assert.equal(await createConnection(NodeID.newUniqueID()), MessageErrorType.NodeNotFound);
        }
        finally
        {
            s.destroy();
        }
    });

    test("CreateConnection without a Message Version 2 capability page is accepted, as in Core", async () =>
    {
        // Core assumes Message Version 2 unless the client sends a page for it
        const s = netConnect(tcp.listenPort, "127.0.0.1");
        s.on("error", () => undefined);
        await new Promise((r) => s.once("connect", r));
        let pending = Buffer.alloc(0);
        const reply = new Promise<Message>((resolve) => s.on("data", (d: Buffer) =>
        {
            pending = Buffer.concat([pending, d]);
            if (pending.length >= 8 && pending.length >= pending.readUInt32LE(4)) resolve(deserializeMessage(new Uint8Array(pending.subarray(0, pending.readUInt32LE(4)))));
        }));
        try
        {
            const m = new Message();
            m.header.senderNodeID = NodeID.newUniqueID();
            const e = new MessageEntry(MessageEntryType.StreamOp, "CreateConnection");
            e.addElement(new MessageElement("capabilities", DataTypes.uint32_t, Uint32Array.of((TransportCapabilityCode.Message4BasicPage | TransportCapabilityCode.Message4BasicEnable) >>> 0)));
            m.entries.push(e);
            s.write(serializeMessage(m));
            const r = (await reply).entries[0]!;
            assert.equal(r.error, MessageErrorType.None);
            assert.deepEqual(r.elements.find((x) => x.elementName === "capabilities")?.data, Uint32Array.of((TransportCapabilityCode.Message2BasicPage | TransportCapabilityCode.Message2BasicEnable) >>> 0));
        }
        finally
        {
            s.destroy();
        }
    });

    test("a connection cannot send requests to the endpoint of a client on another connection", async () =>
    {
        const n1 = newClientNode();
        const n2 = newClientNode();
        try
        {
            const c1 = await n1.connectService(url());
            const c2 = await n2.connectService(url());
            await c1.callFunction("change_s1", ["mine"]);
            const closed = new Promise<void>((resolve) => c2.context.addCloseListener(resolve));

            // Over its own connection, the second client addresses the first client's service endpoint
            const m = new Message();
            m.header.senderNodeID = n2.nodeID;
            m.header.receiverNodeID = server.nodeID;
            m.header.senderEndpoint = c2.context.localEndpoint;
            m.header.receiverEndpoint = c1.context.remoteEndpoint;
            const e = new MessageEntry(MessageEntryType.FunctionCallReq, "change_s1");
            e.servicePath = "test";
            e.requestID = 1000;
            e.addElement(MessageElement.string("s", "forged"));
            m.entries.push(e);
            c2.context.transportConnection!.sendMessage(m);

            // The request is refused with InvalidEndpoint, which closes the second client
            const was_closed = await Promise.race([closed.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 5000))]);
            assert.equal(await c1.callFunction("add", [1, 2]), 3);
            assert.equal(obj.s1, "mine");
            assert.ok(was_closed);
        }
        finally
        {
            await n1.shutdown();
            await n2.shutdown();
        }
    });

    test("every spelling of an objref index gives the one object at the canonical path", async () =>
    {
        // As Core's encode_index: obj[1] and obj[%31] must not be two skels (two locks) for one object
        const c = await client.connectService(url());
        try
        {
            assert.equal(await (await c.context.findObjRef("test.o2[1]")).callFunction("path"), "test.o2[1]");
            assert.equal(await (await c.context.findObjRef("test.o2[%31]")).callFunction("path"), "test.o2[1]");
            assert.equal(await (await c.context.findObjRef("test.o3[a%2Eb]")).callFunction("path"), "test.o3[a%2eb]");
        }
        finally
        {
            await client.disconnectService(c);
        }
    });

    test("a special request with more than one entry closes the connection", async () =>
    {
        // Object protocol, "Special Requests": a special request must be the only entry in its message. Each
        // entry used to be answered, so one message could make the service build a reply of entries x
        // definition size
        const run = async (count: number) =>
        {
            const s = netConnect(tcp.listenPort, "127.0.0.1");
            s.on("error", () => undefined);
            await new Promise((r) => s.once("connect", r));
            const replies: rri.Message[] = [];
            let closed = false;
            let pending = Buffer.alloc(0);
            let wake = () => {};
            s.on("data", (d: Buffer) =>
            {
                pending = Buffer.concat([pending, d]);
                while (pending.length >= 8 && pending.length >= pending.readUInt32LE(4))
                {
                    const n = pending.readUInt32LE(4);
                    replies.push(rri.deserializeMessage(new Uint8Array(pending.subarray(0, n))));
                    pending = pending.subarray(n);
                }
                wake();
            });
            s.on("close", () =>
            {
                closed = true;
                wake();
            });
            const next = async () =>
            {
                const deadline = Date.now() + 5000;
                while (replies.length === 0 && !closed && Date.now() < deadline)
                    await new Promise<void>((r) =>
                    {
                        wake = r;
                        setTimeout(r, 100);
                    });
                return replies.shift();
            };
            const id = RRNodeID.newUniqueID();
            try
            {
                const cc = new rri.Message();
                cc.header.senderNodeID = id;
                const e = new rri.MessageEntry(rri.MessageEntryType.StreamOp, "CreateConnection");
                e.addElement(new rri.MessageElement("capabilities", rri.DataTypes.uint32_t, Uint32Array.of((rri.TransportCapabilityCode.Message2BasicPage | rri.TransportCapabilityCode.Message2BasicEnable) >>> 0)));
                cc.entries.push(e);
                s.write(rri.serializeMessage(cc));
                const cc_ret = await next();
                assert.equal(cc_ret?.entries[0]!.error, rri.MessageErrorType.None);

                const m = new rri.Message();
                m.header.senderNodeID = id;
                m.header.receiverNodeID = server.nodeID;
                m.header.senderEndpoint = 1234;
                for (let i = 0; i < count; i++)
                {
                    const g = new rri.MessageEntry(rri.MessageEntryType.GetServiceDesc, "");
                    g.servicePath = "test";
                    g.requestID = i + 1;
                    m.entries.push(g);
                }
                s.write(rri.serializeMessage(m));
                const ret = await next();
                return { ret, closed };
            }
            finally
            {
                s.destroy();
            }
        };

        const one = await run(1);
        assert.equal(one.ret?.entries.length, 1);
        assert.equal(one.ret?.entries[0]!.entryType, rri.MessageEntryType.GetServiceDescRet);
        assert.equal(one.ret?.entries[0]!.error, rri.MessageErrorType.None);
        assert.equal(one.closed, false);

        const two = await run(2);
        assert.equal(two.ret, undefined);
        assert.equal(two.closed, true);
    });

    test("malformed pipe packet acknowledgements are ignored and do not stop the service", async () =>
    {
        // A void element used to throw outside any catch, and the unhandled rejection stopped the Node process
        const s = netConnect(tcp.listenPort, "127.0.0.1");
        s.on("error", () => undefined);
        await new Promise((r) => s.once("connect", r));
        const replies: Message[] = [];
        let pending = Buffer.alloc(0);
        let wake = () => {};
        s.on("data", (d: Buffer) =>
        {
            pending = Buffer.concat([pending, d]);
            while (pending.length >= 8 && pending.length >= pending.readUInt32LE(4))
            {
                const n = pending.readUInt32LE(4);
                replies.push(deserializeMessage(new Uint8Array(pending.subarray(0, n))));
                pending = pending.subarray(n);
            }
            wake();
        });
        const request = async (m: Message) =>
        {
            s.write(serializeMessage(m));
            while (replies.length === 0) await new Promise<void>((r) => (wake = r));
            return replies.shift()!;
        };
        const id = NodeID.newUniqueID();
        let remote = 0;
        const message = (e: MessageEntry) =>
        {
            const m = new Message();
            m.header.senderNodeID = id;
            m.header.receiverNodeID = server.nodeID;
            m.header.senderEndpoint = 4321;
            m.header.receiverEndpoint = remote;
            e.servicePath = "test";
            e.requestID = 1;
            m.entries.push(e);
            return m;
        };
        try
        {
            const cc = new Message();
            cc.header.senderNodeID = id;
            const e = new MessageEntry(MessageEntryType.StreamOp, "CreateConnection");
            e.addElement(new MessageElement("capabilities", DataTypes.uint32_t, Uint32Array.of((TransportCapabilityCode.Message2BasicPage | TransportCapabilityCode.Message2BasicEnable) >>> 0)));
            cc.entries.push(e);
            assert.equal((await request(cc)).entries[0]!.error, MessageErrorType.None);

            const connected = await request(message(new MessageEntry(MessageEntryType.ConnectClient, "")));
            assert.equal(connected.entries[0]!.error, MessageErrorType.None);
            remote = connected.header.senderEndpoint;

            const before_endpoints = new Set(obj.pp!.activeEndpoints);
            const pc = new MessageEntry(MessageEntryType.PipeConnectReq, "pp");
            pc.addElement(new MessageElement("index", DataTypes.int32_t, Int32Array.of(-1)));
            const pr = await request(message(pc));
            assert.equal(pr.entries[0]!.error, MessageErrorType.None);
            const index = (pr.entries[0]!.elements[0]!.data as Int32Array)[0]!;
            const p = obj.pp!.activeEndpoints.find((x) => !before_endpoints.has(x))!;
            const acks: number[] = [];
            p.packetAckReceivedEvent.addHandler((_p, n) => acks.push(n));

            const ack = new MessageEntry(MessageEntryType.PipePacketRet, "pp");
            ack.addElement(new MessageElement(String(index), DataTypes.void_t, null));
            ack.addElement(new MessageElement(String(index), DataTypes.uint32_t, new Uint32Array(0)));
            ack.addElement(new MessageElement(String(index), DataTypes.string_t, "x"));
            ack.addElement(new MessageElement(String(index), DataTypes.uint32_t, Uint32Array.of(7)));
            s.write(serializeMessage(message(ack)));

            // The service still answers, and only the well formed acknowledgement was delivered
            const alive = await request(message(new MessageEntry(MessageEntryType.ClientKeepAliveReq, "")));
            assert.equal(alive.entries[0]!.entryType, MessageEntryType.ClientKeepAliveRet);
            assert.deepEqual(acks, [7]);
        }
        finally
        {
            s.destroy();
        }
    });

    test("Core's Python client uses the service", { timeout: 60000 }, async () =>
    {
        const script = join(root, "test/server/rr_service_test_client.py");
        const { stdout } = await promisify(execFile)(PYTHON, [script, `rr+tcp://localhost:${tcp.listenPort}?service=test`], { timeout: 50000 });
        assert.match(stdout, /^OK$/m);
    });
});
