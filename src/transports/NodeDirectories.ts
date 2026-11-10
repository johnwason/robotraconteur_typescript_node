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

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The folder where Core keeps the configuration of the current user, as in NodeDirectories.cpp.
 * Node certificates are in its certificates subfolder. As in Core, the system folder is used when
 * running as root, and environment variables can override each folder.
 */
export function userConfigDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, uid: number | undefined = process.getuid?.()): string
{
    if (platform === "win32")
    {
        return env.ROBOTRACONTEUR_USER_CONFIG_DIR ?? join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "RobotRaconteur");
    }
    if (uid === 0)
    {
        return env.ROBOTRACONTEUR_SYSTEM_CONFIG_DIR ?? "/etc/robotraconteur";
    }
    if (env.ROBOTRACONTEUR_USER_CONFIG_DIR) return env.ROBOTRACONTEUR_USER_CONFIG_DIR;
    if (env.ROBOTRACONTEUR_USER_HOME) return join(env.ROBOTRACONTEUR_USER_HOME, ".config", "RobotRaconteur");
    if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "RobotRaconteur");
    return join(env.HOME ?? homedir(), ".config", "RobotRaconteur");
}
