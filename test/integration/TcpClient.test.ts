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
import { after, before, test } from "node:test";
import { RobotRaconteurNode } from "robotraconteur";
import { clientTests } from "@shared/test/common/ClientTests.js";
import type { Vectors } from "@shared/test/common/ClientTests.js";
import { TcpTransport } from "../../src/index.js";
import { loadVectors, startTestServer, TestServer } from "./TestServer.js";

const vectors = loadVectors<Vectors>();
const node = new RobotRaconteurNode();
node.requestTimeout = 30000;
node.registerTransport(new TcpTransport(node));
let server: TestServer;

before(async () =>
{
    assert.ok(process.env.RR_CORE_TEST, "RR_CORE_TEST must point at the Core test directory");
    server = await startTestServer();
}, { timeout: 60000 });

after(async () =>
{
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
