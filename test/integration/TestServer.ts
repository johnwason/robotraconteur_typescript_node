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

import { ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const shared = resolve(process.env.RR_SHARED ?? join(root, "../robotraconteur_typescript"));

export function loadVectors<T>(): T
{
    return JSON.parse(readFileSync(join(shared, "test/fixtures/recorded_vectors.json"), "utf8")) as T;
}

export interface TestServer
{
    process: ChildProcess;
    port: number;
    stop(): void;
}

/** The Python interpreter. Windows usually has no python3 command */
export const PYTHON = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

/** Start a Core test server. RR_TEST_SERVER_SCRIPT selects the C++ server instead of Python */
export async function startTestServer(): Promise<TestServer>
{
    const script = process.env.RR_TEST_SERVER_SCRIPT ?? "test/server/rr_test_server.py";
    const p = spawn(PYTHON, ["-u", join(shared, script)], {
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
        stdio: ["pipe", "pipe", "inherit"]
    });
    const port = await new Promise<number>((res, rej) =>
    {
        let output = "";
        p.stdout!.on("data", (d: Buffer) =>
        {
            output += d.toString();
            const m = /PORT (\d+)\n/.exec(output);
            if (m) res(Number(m[1]));
        });
        p.on("exit", () => rej(new Error("Test server exited")));
    });
    return {
        process: p,
        port,
        stop()
        {
            p.removeAllListeners("exit");
            p.kill();
        }
    };
}
