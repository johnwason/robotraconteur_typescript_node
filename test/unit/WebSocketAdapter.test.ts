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
import { test } from "node:test";
import { WebSocketAdapter } from "../../src/transports/TcpTransport.js";

type Callback = (e?: Error) => void;

/** Records sends, and completes them only when told to */
function fakeSocket(bufferedAmount: number)
{
    const pending: Callback[] = [];
    const ws = {
        readyState: 1,
        bufferedAmount,
        send: (_data: unknown, _options: unknown, cb?: Callback) => pending.push(cb!),
        terminate: () => undefined
    };
    return { ws, pending, adapter: new WebSocketAdapter(ws as unknown as ConstructorParameters<typeof WebSocketAdapter>[0]) };
}

test("a send returns at once while little is queued", () =>
{
    const { adapter, pending } = fakeSocket(100);
    assert.equal(adapter.write(new Uint8Array(10)), undefined);
    assert.equal(pending.length, 1);
    pending[0]!(new Error("lost")); // A later failure must not be unhandled
});

test("a send waits for its data to be written once the queue is full", async () =>
{
    const { adapter, pending } = fakeSocket(64 * 1024);
    let done = false;
    const p = adapter.write(new Uint8Array(10));
    assert.ok(p instanceof Promise);
    void p.then(() => (done = true));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(!done, "the send finished before its data was written");
    pending[0]!();
    await p;
    assert.ok(done);
});

test("a failed or closed send is reported as a connection error", async () =>
{
    const { adapter, pending, ws } = fakeSocket(64 * 1024);
    const p = adapter.write(new Uint8Array(10)) as Promise<void>;
    pending[0]!(new Error("socket closed"));
    await assert.rejects(p, /Transport connection closed/);

    ws.readyState = 3;
    await assert.rejects(adapter.write(new Uint8Array(1)) as Promise<void>, /Transport connection closed/);
});
