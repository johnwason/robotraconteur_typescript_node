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

// User authentication for services, as Core's ServiceSecurityPolicy, UserAuthenticator, and
// PasswordFileUserAuthenticator.

import { createHash } from "node:crypto";
import { NodeID, RobotRaconteurError, VarValue } from "robotraconteur";
import { MessageErrorType } from "robotraconteur/internal";
import type { ServerContext } from "./ServerContext.js";
import type { ServerTransportConnection } from "../transports/StreamConnections.js";

export function authenticationError(message: string): RobotRaconteurError
{
    return new RobotRaconteurError(MessageErrorType.AuthenticationError, "RobotRaconteur.AuthenticationError", message);
}

/** A user that a client has logged in as */
export class AuthenticatedUser
{
    readonly loginTime = new Date();
    lastAccessTime = new Date();

    constructor(readonly username: string, readonly privileges: string[] = [], readonly properties: string[] = [], readonly context: ServerContext | null = null) {}

    /** @internal */
    updateLastAccess(): void
    {
        this.lastAccessTime = new Date();
    }
}

/**
 * Checks a client's username and credentials. Returns the user, or throws, preferably an
 * AuthenticationError, if they are not valid. connection is the client's connection, whose
 * securePeerIdentity is the client's node ID if its TLS certificate has been verified.
 */
export interface UserAuthenticator
{
    authenticateUser(username: string, credentials: Map<string, VarValue>, context: ServerContext, connection: ServerTransportConnection | null): AuthenticatedUser | Promise<AuthenticatedUser>;
}

/**
 * Users from text in Core's password file format: one user per line, with the username, the MD5
 * hash of the password in hex, comma separated privileges or _ for none, and optionally comma
 * separated node IDs of the clients the user may log in from. The privileges objectlock and
 * objectlockoverride allow object locks. Clients give the password as the "password" credential.
 *
 * With requireVerifiedClient, as in Core, users may only log in from a client whose TLS
 * certificate has been verified, which needs rrs+tcp with mutual authentication, and only from
 * the allowed node IDs if a user has them.
 */
export class PasswordFileUserAuthenticator implements UserAuthenticator
{
    private users = new Map<string, { passwordhash: string; privileges: string[]; allowed: NodeID[] }>();

    constructor(data: string, private requireVerifiedClient = false)
    {
        for (const line of data.split("\n"))
        {
            const g = line.trim().split(/\s+/);
            if (g[0] === "") continue;
            if (g.length < 3) throw new RobotRaconteurError(MessageErrorType.InvalidArgument, "RobotRaconteur.InvalidArgument", `Invalid password file line: ${line.trim()}`);
            this.users.set(g[0]!, {
                passwordhash: g[1]!.toLowerCase(),
                privileges: g[2] === "_" ? [] : g[2]!.split(","),
                allowed: g.length > 3 ? g[3]!.split(",").map((x) => new NodeID(x)) : []
            });
        }
    }

    /** The hash stored in a password file for a password */
    static md5Hash(password: string): string
    {
        return createHash("md5").update(password, "utf8").digest("hex");
    }

    authenticateUser(username: string, credentials: Map<string, VarValue>, context: ServerContext, connection: ServerTransportConnection | null = null): AuthenticatedUser
    {
        const u = this.users.get(username);
        if (!u) throw authenticationError("Invalid username or password");
        const password = credentials.get("password")?.value;
        if (typeof password !== "string") throw authenticationError("Password not supplied in credentials");
        if (PasswordFileUserAuthenticator.md5Hash(password) !== u.passwordhash) throw authenticationError("Invalid username or password");
        if (this.requireVerifiedClient)
        {
            const id = connection?.securePeerIdentity;
            if (!id) throw authenticationError("Client connection could not be verified. Check certificate or transport");
            if (u.allowed.length > 0 && !u.allowed.some((x) => x.equals(id))) throw authenticationError("Incorrect client NodeID or certificate error");
        }
        return new AuthenticatedUser(username, [...u.privileges], [], context);
    }
}

/**
 * The security of a service: an authenticator, and policies as in Core. "requirevaliduser":
 * "true" makes clients log in before using the service, and "allowobjectlock": "true" lets users
 * with the objectlock privilege lock objects.
 */
export class ServiceSecurityPolicy
{
    constructor(readonly authenticator: UserAuthenticator, readonly policies: Record<string, string> = {}) {}
}
