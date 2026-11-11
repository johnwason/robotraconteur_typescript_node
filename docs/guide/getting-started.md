---
title: Getting started
---

# Getting started

`robotraconteur-node` adds what Node.js programs need to the [robotraconteur](https://robotraconteur.github.io/robotraconteur_typescript/) TypeScript client:

- the `rr+tcp` transport, and `rr+ws` and `rr+wss` from Node.js
- TLS with Robot Raconteur node certificates (`rrs+tcp`)
- discovery of nodes and services on the network, and subscriptions by service type
- services: serving JavaScript objects to any Robot Raconteur client

Browsers cannot use TCP sockets or UDP, so these are a separate package and the browser library stays small. Using a service, wires, pipes, subscriptions by URL, and value types are the same as in the browser, and are described in the [robotraconteur guide](https://robotraconteur.github.io/robotraconteur_typescript/documents/Using_a_service.html).

Node.js 22 or newer is required.

## Installing

```sh
npm install robotraconteur robotraconteur-node
```

`robotraconteur` is a peer dependency, so that both packages use one copy of it. The API may change in any release before 1.0, so pin the versions and read the changelogs before upgrading.

To run the examples, clone both repositories into one folder, and build `robotraconteur_typescript` and then `robotraconteur_typescript_node` with `npm install` and `npm run build`.

## Connecting over TCP

The API is the one in `robotraconteur`, with {@link TcpTransport} registered:

```js
import { RobotRaconteurNode } from "robotraconteur";
import { TcpTransport } from "robotraconteur-node";

const node = new RobotRaconteurNode();
node.registerTransport(new TcpTransport(node));

const reynard = await node.connectService("rr+tcp://localhost:29200?service=reynard");
await reynard.callFunction("say", ["Hello from Node.js!"]);
await node.disconnectService(reynard);
await node.shutdown();
```

`TcpTransport` also connects to `rr+ws` and `rr+wss` URLs, using the [ws](https://www.npmjs.com/package/ws) package. Do not also register `BrowserWebSocketTransport`, which is for browsers. A server with a certificate from a private certificate authority can be trusted with `webSocketOptions`:

```js
const tcp = new TcpTransport(node);
tcp.webSocketOptions = { ca: readFileSync("my-ca.pem") };
node.registerTransport(tcp);
```

## Next

- [Secure connections](tls.md): `rrs+tcp` for clients and services
- [Finding services](discovery.md): discovery, subscriptions by type, and announcing services
- [Writing services](services.md): serving JavaScript objects
- [Security and locks](security.md): logins, object locks, and monitor locks
- [Hosting in a web server](web-servers.md): Robot Raconteur WebSockets from Express, Next.js, and other servers
