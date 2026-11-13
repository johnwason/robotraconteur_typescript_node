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
import { RobotRaconteurError } from "robotraconteur";
import { Monitor } from "../../src/service/Locks.js";
import type { ServiceSkel } from "../../src/service/ServiceSkel.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a client that timed out waiting for the monitor lock does not hold it", async () =>
{
    // The object takes longer to enter its monitor than the client is willing to wait
    let exits = 0;
    const obj = {
        RobotRaconteurMonitorEnter: () => sleep(100),
        RobotRaconteurMonitorExit: () =>
        {
            exits++;
        }
    };
    const m = new Monitor({ obj } as unknown as ServiceSkel);
    await assert.rejects(m.enter(1, 20), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.RequestTimeout");
    await sleep(200);
    assert.equal(m.lockedBy, 0);
    assert.equal(exits, 1);
    // Another client can lock the object
    assert.equal(await m.enter(2, 1000), "OK");
    assert.equal(m.lockedBy, 2);
});
