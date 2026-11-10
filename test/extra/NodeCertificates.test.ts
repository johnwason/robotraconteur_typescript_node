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

// rrs+tcp with real node certificates issued under the Robot Raconteur roots built into Core. Node
// certificates include private keys, so they are not part of this repository. Set
// RR_NODE_CERTIFICATES to a folder of at least two {nodeid}.p12 files to run these tests.

import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { NodeID, RobotRaconteurNode } from "robotraconteur";
import { TcpTransport } from "../../src/index.js";
import type { TlsClientOptions } from "../../src/index.js";
import { PYTHON, root } from "../integration/TestServer.js";

const folder = process.env.RR_NODE_CERTIFICATES;
const ids = folder ? readdirSync(folder).filter((f) => /^\{[0-9a-f-]{36}\}\.p12$/.test(f)).map((f) => f.slice(0, -4)) : [];

describe("rrs+tcp with real node certificates", { skip: ids.length >= 2 ? false : "RR_NODE_CERTIFICATES is not set to a folder of two or more node certificates" }, () =>
{
    const [server_id, client_id] = ids;
    let config: string;
    let server: ChildProcess;
    let port: number;

    before(async () =>
    {
        // The server looks for its certificate in <config>/certificates
        config = mkdtempSync(join(tmpdir(), "rr_real_certs_"));
        symlinkSync(resolve(folder!), join(config, "certificates"));
        server = spawn(PYTHON, ["-u", join(root, "test/server/rr_tls_test_server.py"), server_id!, config], { stdio: ["pipe", "pipe", "inherit"] });
        port = await new Promise<number>((resolve_port, reject) =>
        {
            let out = "";
            server.stdout!.on("data", (d: Buffer) =>
            {
                out += d.toString();
                const m = /PORT (\d+)\r?\n/.exec(out);
                if (m) resolve_port(Number(m[1]));
            });
            server.on("exit", () => reject(new Error("TLS test server exited")));
        });
    }, { timeout: 60000 });

    after(() =>
    {
        server?.removeAllListeners("exit");
        server?.kill();
        if (config) rmSync(config, { recursive: true, force: true });
    });

    async function connect(options: TlsClientOptions, node_id?: string): Promise<void>
    {
        const node = new RobotRaconteurNode();
        if (node_id) node.nodeID = new NodeID(node_id);
        const tcp = new TcpTransport(node);
        tcp.tlsOptions = options;
        node.registerTransport(tcp);
        try
        {
            const c = await node.connectService(`rrs+tcp://localhost:${port}?nodeid=${server_id!.slice(1, -1)}&service=test_service`);
            assert.equal(await c.callFunction("add_two_numbers", [2, 4]), 6);
        }
        finally
        {
            await node.shutdown();
        }
    }

    test("the server certificate is verified using the built-in roots", { timeout: 30000 }, async () =>
    {
        await connect({});
    });

    test("a real client certificate is accepted", { timeout: 30000 }, async () =>
    {
        await connect({ clientCertificate: { pfx: readFileSync(join(folder!, client_id + ".p12")) } }, client_id);
    });

    test("the certificate is refused without the built-in roots", { timeout: 30000 }, async () =>
    {
        await assert.rejects(connect({ useDefaultRoots: false }), /not issued by a trusted/);
    });
});
