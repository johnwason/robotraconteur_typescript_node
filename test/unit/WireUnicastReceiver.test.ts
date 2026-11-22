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
import type { MemberDefinition, RobotRaconteurError } from "robotraconteur";
import { WireServer, WireUnicastReceiver } from "../../src/service/Wire.js";
import type { ServiceSkel } from "../../src/service/ServiceSkel.js";

test("client peeks of a WireUnicastReceiver apply the value lifespan", async () =>
{
    // As Core's WireUnicastReceiver: a peek, like inValue, fails once the value has expired
    const wire = new WireServer<number>({} as ServiceSkel, { name: "w", kind: "wire" } as unknown as MemberDefinition);
    const r = new WireUnicastReceiver(wire);
    r.inValueLifespan = 10;
    wire.pokeOutValueCallback!(5, { seconds: 0n, nanoseconds: 0 }, 1);
    assert.equal(await wire.peekOutValueCallback!(1), 5);
    // The value arrived a second ago
    (r as unknown as { in_local: number }).in_local = Date.now() - 1000;
    assert.throws(() => r.inValue, (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.ValueNotSet");
    await assert.rejects(async () => wire.peekOutValueCallback!(1), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.ValueNotSet");
});
