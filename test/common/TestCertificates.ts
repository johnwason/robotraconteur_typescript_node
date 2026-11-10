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

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Builds certificate chains shaped like Robot Raconteur node certificates, using the openssl command,
// so that both valid chains and each kind of invalid chain can be tested.

const OID = "1.3.6.1.4.1.45455.1.1.3.";

export interface CertificateOptions
{
    /** The last digit of the Robot Raconteur extension, or null to leave it out */
    level?: number | null;
    /** Mark this certificate as a certificate authority */
    ca?: boolean;
    pathLength?: number;
    keyUsage?: string;
    /** More lines for the openssl extension file */
    extra?: string[];
    days?: number;
}

export interface TestCertificate
{
    name: string;
    pem: string;
    der: Buffer;
    keyFile: string;
    certFile: string;
}

export class TestCertificates
{
    readonly dir = mkdtempSync(join(tmpdir(), "rr_certs_"));
    private serial = 1;

    private openssl(...args: string[]): void
    {
        execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
    }

    private file(name: string): string
    {
        return join(this.dir, name);
    }

    /** Issue a certificate, self signed if no issuer is given */
    issue(name: string, subject: string, issuer: TestCertificate | null, o: CertificateOptions = {}): TestCertificate
    {
        const ca = o.ca ?? false;
        const key = this.file(name + ".key");
        const csr = this.file(name + ".csr");
        const cert = this.file(name + ".pem");
        const ext = this.file(name + ".ext");
        this.openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key);
        this.openssl("req", "-new", "-key", key, "-subj", subject, "-out", csr);

        const lines = [
            `basicConstraints=critical,CA:${ca ? "TRUE" : "FALSE"}${ca && o.pathLength !== undefined ? `,pathlen:${o.pathLength}` : ""}`,
            `keyUsage=critical,${o.keyUsage ?? (ca ? "keyCertSign,cRLSign" : "digitalSignature,keyAgreement")}`,
            "subjectKeyIdentifier=hash",
            ...(o.level === null ? [] : [`${OID}${o.level ?? 3}=critical,DER:0500`]),
            ...(o.extra ?? [])
        ];
        writeFileSync(ext, lines.join("\n") + "\n");

        const args = ["x509", "-req", "-in", csr, "-days", String(o.days ?? 30), "-extfile", ext, "-out", cert, "-set_serial", String(this.serial++)];
        if (issuer) args.push("-CA", issuer.certFile, "-CAkey", issuer.keyFile);
        else args.push("-signkey", key);
        this.openssl(...args);

        const pem = readFileSync(cert, "utf8");
        const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");
        return { name, pem, der, keyFile: key, certFile: cert };
    }

    root(name = "root", o: CertificateOptions = {}): TestCertificate
    {
        return this.issue(name, `/CN=Test Root ${name}`, null, { level: 1, ca: true, pathLength: 1, ...o });
    }

    intermediate(issuer: TestCertificate, name = "intermediate", o: CertificateOptions = {}): TestCertificate
    {
        return this.issue(name, `/CN=Test Intermediate ${name}`, issuer, { level: 2, ca: true, pathLength: 0, ...o });
    }

    node(issuer: TestCertificate, nodeID: string, name = "node", o: CertificateOptions = {}): TestCertificate
    {
        return this.issue(name, `/CN=Robot Raconteur Node ${nodeID}`, issuer, { level: 3, ...o });
    }

    /** Write a PKCS#12 file with no password, as Core expects for a node certificate */
    pkcs12(cert: TestCertificate, chain: TestCertificate[], file: string): string
    {
        const bundle = this.file(cert.name + ".chain.pem");
        writeFileSync(bundle, chain.map((c) => c.pem).join(""));
        mkdirSync(join(file, ".."), { recursive: true });
        this.openssl("pkcs12", "-export", "-inkey", cert.keyFile, "-in", cert.certFile, "-certfile", bundle, "-passout", "pass:", "-out", file);
        return file;
    }

    close(): void
    {
        rmSync(this.dir, { recursive: true, force: true });
    }
}
