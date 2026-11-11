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

// Runs the client tests against the ports of Core's test services served by robotraconteur-node:
// the TypeScript client tests from the robotraconteur package, which are ported from Core's
// Python test clients, and Core's Python test clients themselves.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { RobotRaconteurNode } from "robotraconteur";
import { clientTests } from "@shared/test/common/ClientTests.js";
import type { Vectors } from "@shared/test/common/ClientTests.js";
import { TcpTransport } from "../../src/index.js";
import { startTestServiceNode } from "../service/TestServiceNode.js";
import type { TestServiceNode } from "../service/TestServiceNode.js";
import { loadVectors, PYTHON } from "./TestServer.js";

/**
 * Tests of features that robotraconteur-node services do not support yet, masked by feature.
 * Everything else in Core's service tests and the TypeScript client tests runs, so a new feature
 * is tested by removing its mask. pytest tests are given by function name.
 */
const MASKED: Record<string, { pytest: string[]; client: string[] }> = {
    memories: {
        pytest: [
            "test_memories",
            "test_named_array_memories",
            "test_complex_memories",
            "test_bool_memories"
        ],
        client: []
    },
    locks: {
        pytest: ["test_object_lock", "test_monitor_lock", "test_nolock", "test_async"],
        client: ["ServiceTestClient2 TestNoLock"]
    }
};

const MASKED_PYTEST = Object.values(MASKED).flatMap((m) => m.pytest);
const MASKED_CLIENT = new Set(Object.values(MASKED).flatMap((m) => m.client));

describe("Core test services served by robotraconteur-node", () =>
{
    let server: TestServiceNode;
    const client = new RobotRaconteurNode();
    client.requestTimeout = 30000;
    client.registerTransport(new TcpTransport(client));

    before(async () =>
    {
        server = await startTestServiceNode();
    });

    after(async () =>
    {
        await client.shutdown();
        await server.shutdown();
    });

    // Core's tests at the commit that the test vector blob comes from, which RR_CORE_PYTHON_TESTS
    // points to. Core's fixture connects to ROBOTRACONTEUR_TEST_SERVER_URL instead of starting its
    // own server
    const core_tests = process.env.RR_CORE_PYTHON_TESTS;
    test("Core's Python test clients", { skip: core_tests ? false : "RR_CORE_PYTHON_TESTS is not set", timeout: 300000 }, async () =>
    {
        const dir = join(core_tests!, "RobotRaconteurTest");
        const files = ["test_service.py", "test_service2.py", "test_service3.py"].map((f) => join(dir, f));
        const skip = MASKED_PYTEST.map((t) => "not " + t).join(" and ");
        const r = await promisify(execFile)(PYTHON, ["-m", "pytest", "-p", "no:cacheprovider", "-q", "-rA", "-k", skip, ...files], {
            cwd: core_tests,
            env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ROBOTRACONTEUR_TEST_SERVER_URL: `rr+tcp://localhost:${server.port}` },
            timeout: 280000,
            maxBuffer: 16 * 1024 * 1024
        }).catch((e: { stdout?: string; stderr?: string }) =>
        {
            throw new Error(`pytest failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
        });
        assert.doesNotMatch(r.stdout, / failed| error/, r.stdout);
        assert.match(r.stdout, /\d+ passed/, r.stdout);
    });

    for (const scheme of ["rr+tcp", "rr+ws"])
    {
        describe(`TypeScript client tests over ${scheme}`, () =>
        {
            // The tests are created when the server's port is known
            const names = clientTests(client, 0, loadVectors<Vectors>(), scheme).map((t) => t.name);
            test("every masked client test exists", () =>
            {
                for (const name of MASKED_CLIENT) assert.ok(names.includes(name), name);
            });
            for (const name of names.filter((x) => !MASKED_CLIENT.has(x)))
            {
                test(name, async () =>
                {
                    const t = clientTests(client, server.port, loadVectors<Vectors>(), scheme).find((x) => x.name === name)!;
                    await t.run();
                });
            }
        });
    }
});
