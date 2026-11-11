---
title: Security and locks
---

# Security and locks

## Requiring a login

Pass a {@link ServiceSecurityPolicy} to `registerService` to make clients log in:

```js
import { readFileSync } from "node:fs";
import { PasswordFileUserAuthenticator, ServiceSecurityPolicy } from "robotraconteur-node";

const authenticator = new PasswordFileUserAuthenticator(readFileSync("passwords.txt", "utf8"));
const policy = new ServiceSecurityPolicy(authenticator, {
    requirevaliduser: "true",
    allowobjectlock: "true"
});
node.registerService("robot", "experimental.robot.Robot", new Robot(), policy);
```

The policies are Core's:

| Policy | Meaning |
| --- | --- |
| `requirevaliduser` | `"true"` makes clients log in before they use the service |
| `allowobjectlock` | `"true"` lets users with the `objectlock` privilege lock objects |

Clients log in when they connect, giving the password as the `password` credential:

```js
const robot = await node.connectService("rr+tcp://localhost:22222?service=robot", "operator", { password: "secret" });
```

Use `rrs+tcp`, described in [Secure connections](tls.md), so that the password is not sent in the clear.

## Password files

{@link PasswordFileUserAuthenticator} reads Core's password file format. Each line has a username, the MD5 hash of the password in hex, and comma separated privileges, or `_` for none:

```
operator 5ebe2294ecd0e0f08eab7690d2a6ee69 objectlock
admin 21232f297a57a5a743894a0e4a801fc3 objectlock,objectlockoverride
viewer 4b2a1529867b8d697685b1722ccd0149 _
```

`PasswordFileUserAuthenticator.md5Hash(password)` gives the hash.

`new PasswordFileUserAuthenticator(text, true)` lets users log in only from clients whose TLS certificate has been verified, which needs `rrs+tcp` with mutual authentication, as in Core. A fourth column of comma separated node IDs limits a user to those clients.

## Custom authenticators

Any object with an `authenticateUser(username, credentials, context, connection)` method can be the authenticator. It returns an {@link AuthenticatedUser}, or a promise of one, and throws `RobotRaconteur.AuthenticationError` to refuse the login, as Core's authenticators do. `credentials` is a `Map` of `VarValue`.

```js
import { MessageErrorType, RobotRaconteurError } from "robotraconteur";
import { AuthenticatedUser } from "robotraconteur-node";

const authenticator = {
    async authenticateUser(username, credentials, context) {
        const token = credentials.get("token")?.value;
        if (!(await checkToken(username, token))) {
            throw new RobotRaconteurError(MessageErrorType.AuthenticationError, "RobotRaconteur.AuthenticationError", "Invalid token");
        }
        return new AuthenticatedUser(username, ["objectlock"], [], context);
    }
};
```

Inside a request, `ServerEndpoint.currentAuthenticatedUser` is the user of the request being served, with its `username` and `privileges`.

## Object locks

A client with the `objectlock` privilege can lock an object, and the objects under it, for its user or for its own session, as in Core. Other clients receive `RobotRaconteur.ObjectLockedError` until it is released. A user with `objectlockoverride` can release other users' locks. Members marked `nolock` in the service definition stay usable while the object is locked, and properties marked `nolockread` can still be read.

Clients lock objects with `node.requestObjectLock(obj)` and `node.releaseObjectLock(obj)`, as Core's clients do with `RequestObjectLock` and `ReleaseObjectLock`.

The service can lock an object itself, with a username that no client logs in as:

```js
await context.requestObjectLock("robot.tool", "server");
```

## Monitor locks

Monitor locks give one client at a time an object, for a sequence of requests. Clients use `node.monitorEnter(obj, timeout)` and `node.monitorExit(obj)`. They need no privilege or security policy. An object's `RobotRaconteurMonitorEnter(timeout)` and `RobotRaconteurMonitorExit()` methods are called if it has them, as in Python. A client's monitor lock is released when it disconnects.
