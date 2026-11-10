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

// Tests against public servers, like test/extra/tcp_tls/test_ws_https.py in Core. They need internet
// access, so they are not part of npm test. Run them with npm run test:extra.

import assert from "node:assert/strict";
import { test } from "node:test";
import { RobotRaconteurNode } from "robotraconteur";
import { TcpTransport } from "../../src/index.js";

test("rr+wss connects to the public WebSocket test server", { timeout: 30000 }, async () =>
{
    const node = new RobotRaconteurNode();
    node.registerTransport(new TcpTransport(node));
    try
    {
        const c = await node.connectService("rr+wss://wstest2.wasontech.com/robotraconteur?service=testobj");
        assert.equal(await c.callFunction("add_two_numbers", [2, 4]), 6);
    }
    finally
    {
        await node.shutdown();
    }
});
