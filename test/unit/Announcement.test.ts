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
import test from "node:test";
import { NodeID } from "robotraconteur";
import { parseNodeAnnouncement } from "../../src/index.js";

const ID = "01234567-89ab-4def-8123-456789abcdef";
const BRACED = `{${ID}}`;
const MAGIC = "Robot Raconteur Node Discovery Packet";

function packet(host: string, name = "my_node", id = BRACED, url_id = ID): string
{
    return `${MAGIC}\n${id},${name}\nrr+tcp://${host}:22222/?nodeid=${url_id}&service=RobotRaconteurServiceIndex\nServiceStateNonce: abc123\n`;
}

test("a valid IPv6 link-local announcement is parsed", () =>
{
    const a = parseNodeAnnouncement(packet("[fe80::1]"), "fe80::1%eth0");
    assert.ok(a);
    assert.ok(a.nodeID.equals(new NodeID(ID)));
    assert.equal(a.nodeName, "my_node");
    assert.equal(a.serviceStateNonce, "abc123");
});

test("a node name is optional", () =>
{
    const p = `${MAGIC}\n${BRACED}\nrr+tcp://[fe80::1]:22222/?nodeid=${ID}&service=RobotRaconteurServiceIndex\n`;
    const a = parseNodeAnnouncement(p, "fe80::1");
    assert.equal(a?.nodeName, "");
    assert.equal(a?.serviceStateNonce, "");
});

test("IPv4 announcements must be from the same /16 as the sender", () =>
{
    assert.ok(parseNodeAnnouncement(packet("192.168.5.7"), "192.168.1.1"));
    assert.equal(parseNodeAnnouncement(packet("192.169.5.7"), "192.168.1.1"), null);
});

test("announcements that Core rejects are rejected", () =>
{
    assert.equal(parseNodeAnnouncement("something else\n", "fe80::1"), null);
    assert.equal(parseNodeAnnouncement(MAGIC, "fe80::1"), null);
    assert.equal(parseNodeAnnouncement(`${MAGIC}\nnot-an-id\nrr+tcp://[fe80::1]:1/?service=x\n`, "fe80::1"), null);
    // The node in the URL must be the announcing node
    assert.equal(parseNodeAnnouncement(packet("[fe80::1]", "n", BRACED, "11111111-89ab-4def-8123-456789abcdef"), "fe80::1"), null);
    // Global IPv6 addresses and mismatched address families are not accepted
    assert.equal(parseNodeAnnouncement(packet("[2001:db8::1]"), "2001:db8::1"), null);
    assert.equal(parseNodeAnnouncement(packet("192.168.1.1"), "fe80::1"), null);
    // Hostnames are not accepted, only addresses
    assert.equal(parseNodeAnnouncement(packet("example.com"), "192.168.1.1"), null);
    assert.equal(parseNodeAnnouncement(`${MAGIC}\n${BRACED}\nrr+tcp://[fe80::1]:1/?nodeid=${ID}&service=${"x".repeat(300)}\n`, "fe80::1"), null);
});

test("loopback announcements are accepted", () =>
{
    assert.ok(parseNodeAnnouncement(packet("127.0.0.1"), "10.0.0.1"));
    assert.ok(parseNodeAnnouncement(packet("[::1]"), "fe80::1"));
});
