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
import { PipeEndpoint } from "../../src/service/Pipe.js";
import type { PipeServer } from "../../src/service/Pipe.js";

test("reliable pipe endpoints hold only packets a bounded distance ahead", () =>
{
    const ep = new PipeEndpoint<number>({ memberName: "p" } as unknown as PipeServer<number>, 1, 10, false, "both");
    const out_of_order = (ep as unknown as { out_of_order: Map<number, unknown> }).out_of_order;
    ep.packetReceived(1, 1);
    // Already received, and too far ahead: dropped
    ep.packetReceived(10, 1);
    ep.packetReceived(10, 0);
    ep.packetReceived(10, 2000);
    ep.packetReceived(10, 0xffffffff);
    assert.equal(out_of_order.size, 0);
    ep.packetReceived(1025, 1025);
    ep.packetReceived(3, 3);
    assert.equal(out_of_order.size, 2);
    ep.packetReceived(2, 2);
    assert.equal(ep.available, 3);
    assert.equal(out_of_order.size, 1);
});
