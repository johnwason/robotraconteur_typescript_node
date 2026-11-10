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
import { X509Certificate } from "node:crypto";
import { after, test } from "node:test";
import { NodeID } from "robotraconteur";
import { readExtensions, verifyNodeCertificate } from "../../src/transports/NodeCertificate.js";
import { ROOT_CA_2015, ROOT_CA_2020 } from "../../src/transports/RootCertificates.js";
import { TestCertificates } from "../common/TestCertificates.js";

const certs = new TestCertificates();
after(() => certs.close());

const id = NodeID.newUniqueID();
const root = certs.root();
const intermediate = certs.intermediate(root);
const node = certs.node(intermediate, id.toString());
const roots = [new X509Certificate(root.pem)];

function rejects(chain: Buffer[], expected: RegExp, options: { nodeID?: NodeID; roots?: X509Certificate[]; now?: Date } = {}): void
{
    assert.throws(() => verifyNodeCertificate(chain, { roots, nodeID: id, ...options }), (e: Error) => e.name === "CertificateError" && expected.test(e.message));
}

test("a valid chain is accepted", () =>
{
    verifyNodeCertificate([node.der, intermediate.der], { roots, nodeID: id });
    // The root may also be sent
    verifyNodeCertificate([node.der, intermediate.der, root.der], { roots, nodeID: id });
});

test("the certificate must be for the expected node", () =>
{
    rejects([node.der, intermediate.der], /rather than "CN=Robot Raconteur Node/, { nodeID: NodeID.newUniqueID() });
    const other_subject = certs.issue("other_subject", `/O=Someone/CN=Robot Raconteur Node ${id.toString()}`, intermediate, { level: 3 });
    rejects([other_subject.der, intermediate.der], /rather than/);
});

test("the chain must lead to a trusted root", () =>
{
    rejects([node.der, intermediate.der], /not issued by a trusted/, { roots: [] });
    const other_root = certs.root("other_root");
    const other_node = certs.node(certs.intermediate(other_root, "other_intermediate"), id.toString(), "other_node");
    rejects([other_node.der], /not issued by a trusted/);
    // Without the intermediate there is no path
    rejects([node.der], /not issued by a trusted/);
});

test("each level must carry its Robot Raconteur extension", () =>
{
    const no_oid = certs.node(intermediate, id.toString(), "no_oid", { level: null });
    rejects([no_oid.der, intermediate.der], /not a Robot Raconteur node certificate/);

    // Another level's extension is an unknown critical extension for this level, as in Core
    const wrong_level = certs.node(intermediate, id.toString(), "wrong_level", { level: 2 });
    rejects([wrong_level.der, intermediate.der], /unsupported critical extension 1\.3\.6\.1\.4\.1\.45455\.1\.1\.3\.2/);

    const plain_intermediate = certs.intermediate(root, "plain_intermediate", { level: null });
    rejects([certs.node(plain_intermediate, id.toString(), "under_plain").der, plain_intermediate.der], /not a Robot Raconteur intermediate/);

    const plain_root = certs.root("plain_root", { level: null });
    const under_plain_root = certs.intermediate(plain_root, "under_plain_root");
    rejects([certs.node(under_plain_root, id.toString(), "n2").der, under_plain_root.der], /not a Robot Raconteur root/, { roots: [new X509Certificate(plain_root.pem)] });
});

test("an unknown critical extension is rejected", () =>
{
    const extra = certs.node(intermediate, id.toString(), "extra", { extra: ["1.2.3.4.5=critical,DER:0500"] });
    rejects([extra.der, intermediate.der], /unsupported critical extension 1\.2\.3\.4\.5/);

    // A known extension that is not critical is fine
    const noncritical = certs.node(intermediate, id.toString(), "noncritical", { extra: ["1.2.3.4.5=DER:0500"] });
    verifyNodeCertificate([noncritical.der, intermediate.der], { roots, nodeID: id });
});

test("issuers must be certificate authorities allowed to sign", () =>
{
    const not_ca = certs.intermediate(root, "not_ca", { ca: false });
    rejects([certs.node(not_ca, id.toString(), "under_not_ca").der, not_ca.der], /not issued by a trusted/);

    // Node.js does not treat it as the issuer at all, and the key usage is checked again as well
    const no_sign = certs.intermediate(root, "no_sign", { keyUsage: "digitalSignature" });
    rejects([certs.node(no_sign, id.toString(), "under_no_sign").der, no_sign.der], /not issued by a trusted|may not sign certificates/);
});

test("path length limits are enforced", () =>
{
    const short_root = certs.root("short_root", { pathLength: 0 });
    const below = certs.intermediate(short_root, "below_short_root");
    rejects([certs.node(below, id.toString(), "n3").der, below.der], /longer than the root certificate allows/, { roots: [new X509Certificate(short_root.pem)] });
});

test("certificates must be in date", () =>
{
    rejects([node.der, intermediate.der], /expired/, { now: new Date(Date.now() + 365 * 86400000) });
    rejects([node.der, intermediate.der], /not valid until/, { now: new Date(Date.now() - 365 * 86400000) });
});

test("the built-in roots are Core's Robot Raconteur roots", () =>
{
    for (const pem of [ROOT_CA_2015, ROOT_CA_2020])
    {
        const c = new X509Certificate(pem);
        assert.ok(c.ca && c.checkIssued(c) && c.verify(c.publicKey), c.subject);
        assert.ok(readExtensions(c.raw).some((e) => e.critical && e.oid === "1.3.6.1.4.1.45455.1.1.3.1"));
        assert.ok(Date.parse(c.validTo) > Date.parse("2045-01-01"));
    }
    assert.equal(new X509Certificate(ROOT_CA_2020).fingerprint256.replace(/:/g, "").toLowerCase(), "4bdc4ec4b520aeea3d468b386ba8f70bf9d1dc3cdcec1297bda2691297c90464");
});
