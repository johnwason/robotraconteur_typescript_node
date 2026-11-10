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
import { join } from "node:path";
import { NodeID } from "robotraconteur";
import { TestCertificates } from "../common/TestCertificates.js";
import type { TestCertificate } from "../common/TestCertificates.js";
import { PYTHON, root } from "./TestServer.js";

export const TLS_TEST_TYPE = "experimental.tls_test.testobj";

export interface TlsTestServer
{
    id: NodeID;
    port: number;
}

/**
 * Core TLS servers using a certificate authority made for the test. They require TLS and announce
 * themselves for discovery. Core is told to trust the authority for client certificates with
 * ROBOTRACONTEUR_SSL_CERT_FILE.
 */
export class TlsTestServers
{
    readonly certs = new TestCertificates();
    readonly ca: TestCertificate;
    readonly intermediate: TestCertificate;
    private processes: ChildProcess[] = [];

    constructor()
    {
        this.ca = this.certs.root();
        this.intermediate = this.certs.intermediate(this.ca);
    }

    /** Start a server as the given node, presenting a certificate for certificate_id, or for itself if that is Any */
    async start(name: string, id = NodeID.newUniqueID(), certificate_id = NodeID.Any, trust_ca = true): Promise<TlsTestServer>
    {
        const config = join(this.certs.dir, name);
        const cert = this.certs.node(this.intermediate, (certificate_id.isAnyNode ? id : certificate_id).toString(), name);
        this.certs.pkcs12(cert, [this.intermediate], join(config, "certificates", id.toString() + ".p12"));
        const args = ["-u", join(root, "test/server/rr_tls_test_server.py"), id.toString(), config, ...(trust_ca ? ["--ca", this.ca.certFile] : [])];
        const p = spawn(PYTHON, args, { stdio: ["pipe", "pipe", "inherit"] });
        this.processes.push(p);
        const port = await new Promise<number>((resolve, reject) =>
        {
            let out = "";
            p.stdout!.on("data", (d: Buffer) =>
            {
                out += d.toString();
                const m = /PORT (\d+)\r?\n/.exec(out);
                if (m) resolve(Number(m[1]));
            });
            p.on("exit", () => reject(new Error("TLS test server exited")));
        });
        return { id, port };
    }

    /** Stop the servers. Closing their input lets them remove anything they added to a certificate store */
    async close(): Promise<void>
    {
        await Promise.all(this.processes.map((p) => new Promise<void>((resolve) =>
        {
            p.removeAllListeners("exit");
            if (p.exitCode !== null)
            {
                resolve();
                return;
            }
            const timer = setTimeout(() => p.kill(), 5000);
            p.once("exit", () =>
            {
                clearTimeout(timer);
                resolve();
            });
            p.stdin!.end();
        })));
        this.certs.close();
    }
}
