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
import { join } from "node:path";
import { test } from "node:test";
import { userConfigDir } from "../../src/transports/NodeDirectories.js";

// The same rules as NodeDirectories.cpp in Core

test("the user configuration folder on Linux and macOS", () =>
{
    assert.equal(userConfigDir({ HOME: "/home/a" }, "linux", 1000), "/home/a/.config/RobotRaconteur");
    assert.equal(userConfigDir({ HOME: "/home/a", XDG_CONFIG_HOME: "/xdg" }, "linux", 1000), join("/xdg", "RobotRaconteur"));
    assert.equal(userConfigDir({ HOME: "/home/a", XDG_CONFIG_HOME: "/xdg", ROBOTRACONTEUR_USER_HOME: "/rr" }, "darwin", 1000), "/rr/.config/RobotRaconteur");
    assert.equal(userConfigDir({ HOME: "/home/a", ROBOTRACONTEUR_USER_CONFIG_DIR: "/cfg" }, "linux", 1000), "/cfg");
});

test("root uses the system configuration folder", () =>
{
    assert.equal(userConfigDir({ HOME: "/root", ROBOTRACONTEUR_USER_CONFIG_DIR: "/cfg" }, "linux", 0), "/etc/robotraconteur");
    assert.equal(userConfigDir({ ROBOTRACONTEUR_SYSTEM_CONFIG_DIR: "/sys" }, "linux", 0), "/sys");
});

test("the user configuration folder on Windows", () =>
{
    assert.equal(userConfigDir({ LOCALAPPDATA: "C:/Users/a/AppData/Local" }, "win32", undefined), join("C:/Users/a/AppData/Local", "RobotRaconteur"));
    assert.equal(userConfigDir({ LOCALAPPDATA: "C:/x", ROBOTRACONTEUR_USER_CONFIG_DIR: "D:/cfg" }, "win32", undefined), "D:/cfg");
});
