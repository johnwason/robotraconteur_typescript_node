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
import { Monitor } from "../../src/service/Locks.js";
import type { ServiceSkel } from "../../src/service/ServiceSkel.js";

test("the next client gets the monitor lock only after RobotRaconteurMonitorExit has finished", async () =>
{
    // As in Core, where MonitorExit runs before the lock is given to another client
    const events: string[] = [];
    let finish_exit = () => {};
    const obj = {
        RobotRaconteurMonitorEnter: () => void events.push("enter"),
        RobotRaconteurMonitorExit: () =>
        {
            events.push("exit start");
            return new Promise<void>((resolve) => (finish_exit = () =>
            {
                events.push("exit end");
                resolve();
            }));
        }
    };
    const m = new Monitor({ obj } as unknown as ServiceSkel);
    assert.equal(await m.enter(1, 1000), "OK");
    const exited = m.exit(1);
    const entered = m.enter(2, 1000);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(events, ["enter", "exit start"]);
    finish_exit();
    assert.equal(await exited, "OK");
    assert.equal(await entered, "OK");
    assert.deepEqual(events, ["enter", "exit start", "exit end", "enter"]);
    assert.equal(m.lockedBy, 2);
    const exited2 = m.exit(2);
    finish_exit();
    assert.equal(await exited2, "OK");
});
