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

import { X509Certificate } from "node:crypto";
import type { NodeID } from "robotraconteur";

// Verification of Robot Raconteur node certificates, as done by Core in OpenSSLAuthContext.cpp.
// Node certificates mark each level of the chain with a critical extension that OpenSSL does not
// recognize, so the TLS module of Node.js always rejects them. The chain is checked here instead.

const OID_KEY_USAGE = "2.5.29.15";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
/** Critical extensions that may appear on any certificate in the chain, as in Core */
const ALLOWED_CRITICAL = new Set([OID_KEY_USAGE, "2.5.29.14", OID_BASIC_CONSTRAINTS, "2.5.29.35", "2.5.29.32"]);
const OID_ROOT = "1.3.6.1.4.1.45455.1.1.3.1";
const OID_INTERMEDIATE = "1.3.6.1.4.1.45455.1.1.3.2";
const OID_NODE = "1.3.6.1.4.1.45455.1.1.3.3";
/** Bit 5 of key usage, keyCertSign, counted from the most significant bit of the first byte */
const KEY_CERT_SIGN = 0x04;
const MAX_CHAIN = 4;

/** A certificate was rejected. The message says why */
export class CertificateError extends Error
{
    constructor(message: string)
    {
        super(message);
        this.name = "CertificateError";
    }
}

export interface CertificateExtension
{
    oid: string;
    critical: boolean;
    value: Uint8Array;
}

interface Tlv
{
    tag: number;
    start: number;
    end: number;
}

function readTlv(b: Uint8Array, pos: number, limit: number): Tlv
{
    if (pos + 2 > limit) throw new CertificateError("Truncated certificate");
    const tag = b[pos]!;
    let len = b[pos + 1]!;
    let start = pos + 2;
    if (len & 0x80)
    {
        const n = len & 0x7f;
        if (n === 0 || n > 4 || start + n > limit) throw new CertificateError("Invalid certificate length");
        len = 0;
        for (let i = 0; i < n; i++) len = len * 256 + b[start + i]!;
        start += n;
    }
    if (start + len > limit) throw new CertificateError("Truncated certificate");
    return { tag, start, end: start + len };
}

function children(b: Uint8Array, t: Tlv): Tlv[]
{
    const out: Tlv[] = [];
    for (let pos = t.start; pos < t.end;)
    {
        const c = readTlv(b, pos, t.end);
        out.push(c);
        pos = c.end;
    }
    return out;
}

function oidToString(b: Uint8Array): string
{
    const parts: number[] = [];
    let value = 0;
    for (const x of b)
    {
        value = value * 128 + (x & 0x7f);
        if ((x & 0x80) === 0)
        {
            if (parts.length === 0) parts.push(value < 80 ? Math.floor(value / 40) : 2, value < 80 ? value % 40 : value - 80);
            else parts.push(value);
            value = 0;
        }
    }
    return parts.join(".");
}

/** Read the extensions of a DER certificate, which Node.js does not expose */
export function readExtensions(der: Uint8Array): CertificateExtension[]
{
    const cert = readTlv(der, 0, der.length);
    const tbs = children(der, cert)[0];
    if (!tbs || tbs.tag !== 0x30) throw new CertificateError("Invalid certificate");
    const ext_field = children(der, tbs).find((t) => t.tag === 0xa3);
    if (!ext_field) return [];
    const list = children(der, ext_field)[0];
    if (!list || list.tag !== 0x30) throw new CertificateError("Invalid certificate extensions");

    return children(der, list).map((e) =>
    {
        const f = children(der, e);
        if (f[0]?.tag !== 0x06) throw new CertificateError("Invalid certificate extension");
        const critical = f[1]?.tag === 0x01 ? der[f[1].start] !== 0 : false;
        const value = f[f.length - 1]!;
        if (value.tag !== 0x04) throw new CertificateError("Invalid certificate extension");
        return { oid: oidToString(der.subarray(f[0].start, f[0].end)), critical, value: der.subarray(value.start, value.end) };
    });
}

/** The path length limit of a CA certificate, or undefined if there is none */
function pathLength(ext: CertificateExtension | undefined): number | undefined
{
    if (!ext) return undefined;
    const seq = readTlv(ext.value, 0, ext.value.length);
    const n = children(ext.value, seq).find((t) => t.tag === 0x02);
    if (!n) return undefined;
    let v = 0;
    for (let i = n.start; i < n.end; i++) v = v * 256 + ext.value[i]!;
    return v;
}

function canSignCertificates(ext: CertificateExtension | undefined): boolean
{
    if (!ext) return true;
    const bits = readTlv(ext.value, 0, ext.value.length);
    // The first content byte is the number of unused bits
    return bits.end - bits.start >= 2 && (ext.value[bits.start + 1]! & KEY_CERT_SIGN) !== 0;
}

function checkExtensions(c: X509Certificate, required_oid: string, what: string): CertificateExtension[]
{
    const exts = readExtensions(c.raw);
    for (const e of exts.filter((x) => x.critical))
    {
        if (!ALLOWED_CRITICAL.has(e.oid) && e.oid !== required_oid) throw new CertificateError(`The ${what} certificate has an unsupported critical extension ${e.oid}`);
    }
    if (!exts.some((e) => e.critical && e.oid === required_oid)) throw new CertificateError(`The ${what} certificate is not a Robot Raconteur ${what} certificate`);
    return exts;
}

function checkDates(c: X509Certificate, what: string, now: Date): void
{
    if (now.getTime() < Date.parse(c.validFrom)) throw new CertificateError(`The ${what} certificate is not valid until ${c.validFrom}`);
    if (now.getTime() > Date.parse(c.validTo)) throw new CertificateError(`The ${what} certificate expired on ${c.validTo}`);
}

function issues(issuer: X509Certificate, c: X509Certificate): boolean
{
    return c.checkIssued(issuer) && c.verify(issuer.publicKey);
}

export interface NodeCertificateOptions
{
    /** Root certificates to trust */
    roots: X509Certificate[];
    /** The node the certificate must identify */
    nodeID: NodeID;
    /** The time to check validity at. Defaults to now */
    now?: Date;
}

/**
 * Check a node certificate chain as Core does: each certificate must be in date and carry the
 * Robot Raconteur extension for its level, the chain must lead to a trusted root, and the node
 * certificate must name the expected node. Throws CertificateError if any check fails.
 *
 * @param chain The certificates sent by the peer, node certificate first, as DER
 */
export function verifyNodeCertificate(chain: Uint8Array[], options: NodeCertificateOptions): void
{
    if (chain.length === 0) throw new CertificateError("No certificate was sent");
    const now = options.now ?? new Date();
    const certs = chain.map((d) => new X509Certificate(d));
    const leaf = certs[0]!;

    const expected = `CN=Robot Raconteur Node ${options.nodeID.toString()}`;
    if (leaf.subject !== expected) throw new CertificateError(`The certificate is for "${leaf.subject.replace(/\n/g, ", ")}" rather than "${expected}"`);
    checkExtensions(leaf, OID_NODE, "node");
    checkDates(leaf, "node", now);

    // Follow issuers up to a trusted root, using only the certificates the peer sent
    const path: X509Certificate[] = [leaf];
    for (;;)
    {
        const current = path[path.length - 1]!;
        const root = options.roots.find((r) => issues(r, current));
        if (root)
        {
            path.push(root);
            break;
        }
        if (path.length >= MAX_CHAIN) throw new CertificateError("The certificate chain is too long");
        const next = certs.find((c) => !path.includes(c) && c.ca && issues(c, current));
        if (!next) throw new CertificateError("The certificate is not issued by a trusted Robot Raconteur root");
        path.push(next);
    }

    // Check each issuer. Path lengths count the intermediates below each certificate
    for (let i = 1; i < path.length; i++)
    {
        const c = path[i]!;
        const is_root = i === path.length - 1;
        const what = is_root ? "root" : "intermediate";
        const exts = checkExtensions(c, is_root ? OID_ROOT : OID_INTERMEDIATE, what);
        checkDates(c, what, now);
        if (!c.ca) throw new CertificateError(`The ${what} certificate is not a certificate authority`);
        if (!canSignCertificates(exts.find((e) => e.oid === OID_KEY_USAGE))) throw new CertificateError(`The ${what} certificate may not sign certificates`);
        const limit = pathLength(exts.find((e) => e.oid === OID_BASIC_CONSTRAINTS));
        if (limit !== undefined && i - 1 > limit) throw new CertificateError(`The certificate chain is longer than the ${what} certificate allows`);
    }
}
