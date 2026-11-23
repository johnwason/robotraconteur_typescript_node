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
import { MessageEntry, MessageEntryType } from "robotraconteur/internal";
import type { MemberDefinition } from "robotraconteur";
import { WireBroadcaster, WireServer, WireUnicastReceiver } from "../../src/index.js";
import type { ServerEndpoint } from "../../src/index.js";

// A skel with just what WireServer needs to accept connections and send packets
function newWire(modifiers: string[], sent: MessageEntry[]): WireServer<number>
{
    const client = { send: (m: MessageEntry[]) => sent.push(...m) };
    const skel = {
        servicePath: "test",
        context: { getClient: () => client },
        pack: (name: string) => ({ elementName: name })
    };
    const member = { name: "w", type: { type: "double" }, modifiers } as unknown as MemberDefinition;
    return new WireServer<number>(skel as never, member);
}

async function connect(wire: WireServer<number>): Promise<void>
{
    const ep = { localEndpoint: 7 } as unknown as ServerEndpoint;
    await wire.command(new MessageEntry(MessageEntryType.WireConnectReq, "w"), ep);
}

test("a repeated wire connect from a client does not add another WireUnicastReceiver handler", async () =>
{
    const wire = newWire(["writeonly"], []);
    const r = new WireUnicastReceiver(wire);
    let events = 0;
    r.inValueChanged.addHandler(() => events++);
    await connect(wire);
    await connect(wire);
    await connect(wire);
    assert.equal(wire.activeConnections.length, 1);
    const c = wire.activeConnections[0]!;
    assert.equal(c.closed, false);
    c.wireValueChanged.fire(c, 1.5, { seconds: 1n, nanoseconds: 0 });
    assert.equal(events, 1);
    assert.equal(r.inValue, 1.5);
});

test("a repeated wire connect from a client is not sent the WireBroadcaster value again", async () =>
{
    const sent: MessageEntry[] = [];
    const wire = newWire(["readonly"], sent);
    const b = new WireBroadcaster(wire);
    b.outValue = 2.5;
    await connect(wire);
    assert.equal(sent.length, 1);
    await connect(wire);
    await connect(wire);
    assert.equal(sent.length, 1);
    assert.equal(b.activeWireConnectionCount, 1);
    b.outValue = 3.5;
    assert.equal(sent.length, 2);
});
