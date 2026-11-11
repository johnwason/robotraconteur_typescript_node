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

// Serves the ports of Core's test services the same way as Core's test server,
// test/python/RobotRaconteurTest/service_test_util.py, so that Core's test clients and the
// ported TypeScript test clients can be run against a robotraconteur-node service.
//
// RobotRaconteurTestService_auth is not served, because services do not support authentication
// yet.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RobotRaconteurNode, VarValue } from "robotraconteur";
import { TcpTransport } from "../../src/index.js";
import { shared } from "../integration/TestServer.js";
import { testroot_impl } from "./ServiceTest.js";
import { testroot3_impl } from "./ServiceTest2.js";
import { asynctestroot_impl } from "./ServiceTest3.js";

export interface TestServiceNode
{
    node: RobotRaconteurNode;
    tcp: TcpTransport;
    port: number;
    shutdown(): Promise<void>;
}

export async function startTestServiceNode(): Promise<TestServiceNode>
{
    const node = new RobotRaconteurNode();
    node.nodeName = "rr_ts_test_service";
    const tcp = new TcpTransport(node);
    node.registerTransport(tcp);

    for (const n of [2, 1, 3, 4, 5])
    {
        node.registerServiceType(readFileSync(join(shared, `test/robdef/com.robotraconteur.testing.TestService${n}.robdef`), "utf8"));
    }

    await tcp.startServer(0);

    const c = node.registerService("RobotRaconteurTestService", "com.robotraconteur.testing.TestService1.testroot", new testroot_impl());
    c.attributes.set("test", new VarValue("This is a test attribute", "string"));
    c.attributes.set("test2", new VarValue(Int32Array.of(42), "int32"));

    node.registerService("RobotRaconteurTestService2", "com.robotraconteur.testing.TestService3.testroot3", new testroot3_impl());
    node.registerService("RobotRaconteurTestService3", "com.robotraconteur.testing.TestService5.asynctestroot", new asynctestroot_impl());

    return {
        node,
        tcp,
        port: tcp.listenPort,
        shutdown: () => node.shutdown()
    };
}
