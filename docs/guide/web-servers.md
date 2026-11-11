---
title: Hosting in a web server
---

# Hosting in a web server

A service can take Robot Raconteur WebSockets from the application's own web server, as RobotRaconteurWeb does from ASP.NET, so that one server gives both the web pages and the service. Browser clients then connect to the same address as the page.

## Node.js http and https servers

Call {@link TcpTransport.handleUpgrade} from the server's `upgrade` event. `startServer` is not needed.

```js
import { createServer } from "node:http";
import { RobotRaconteurNode } from "robotraconteur";
import { TcpTransport } from "robotraconteur-node";

const node = new RobotRaconteurNode();
const tcp = new TcpTransport(node);
node.registerTransport(tcp);
node.registerServiceType(definition);
node.registerService("testobj", "experimental.wstest.testobj", new testobj_impl());

const server = createServer(handleRequest);
server.on("upgrade", (req, socket, head) => {
    if (req.url?.split("?")[0] === "/robotraconteur") void tcp.handleUpgrade(req, socket, head);
    else socket.destroy();
});
server.listen(8080);
```

Clients connect with the URL of the request, such as `rr+ws://localhost:8080/robotraconteur?service=testobj`, or `rr+wss` from an `https` server. `examples/wstest_server.mjs` is a complete server, the same as the ASP.NET wstest server for RobotRaconteurWeb.

`handleUpgrade` makes Core's checks: the request must ask for the Robot Raconteur subprotocol if it asks for any, and come from an origin in `tcp.webSocketAllowedOrigins` if it has one. A refused request receives an HTTP error. The service index reports the URL from the request's `Host` header and path.

## Express

An Express app runs on a Node.js server, so the server's `upgrade` event is used the same way:

```js
import express from "express";
import { createServer } from "node:http";

const app = express();
app.use(express.static("public"));

const server = createServer(app);
server.on("upgrade", (req, socket, head) => {
    if (req.url?.split("?")[0] === "/robotraconteur") void tcp.handleUpgrade(req, socket, head);
    else socket.destroy();
});
server.listen(3000);
```

Fastify and Koa also run on a Node.js server, which `fastify.server` or `app.listen()` returns.

## Next.js

Next.js handles WebSockets only from a custom server, as its route handlers cannot upgrade connections:

```js
import { createServer } from "node:http";
import next from "next";

const app = next({ dev: process.env.NODE_ENV !== "production" });
await app.prepare();
const handle = app.getRequestHandler();
const upgrade = app.getUpgradeHandler();

const server = createServer((req, res) => handle(req, res));
server.on("upgrade", (req, socket, head) => {
    if (req.url?.split("?")[0] === "/robotraconteur") void tcp.handleUpgrade(req, socket, head);
    else upgrade(req, socket, head);
});
server.listen(3000);
```

Other upgrades go to Next.js, which uses them for hot reloading during development. A custom server cannot be deployed to serverless hosts such as Vercel.

## Servers that accept the WebSocket

A server that accepts WebSockets itself with the `ws` library can pass each one to {@link TcpTransport.acceptWebSocket}, with the URL the client used:

```js
import { WebSocketServer } from "ws";

const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has("robotraconteur.robotraconteur.com") ? "robotraconteur.robotraconteur.com" : false)
});

// After the application's own checks of the request
wss.handleUpgrade(req, socket, head, (ws) => {
    void tcp.acceptWebSocket(ws, `ws://${req.headers.host}/robotraconteur`);
});
```

The server is then responsible for the checks that `handleUpgrade` makes, and must confirm the `robotraconteur.robotraconteur.com` subprotocol when the client asks for it, as browsers require. A `wss` or `https` URL marks the connection as secure.

## Behind a proxy

A proxy such as nginx must pass the upgrade on:

```nginx
location /robotraconteur {
    proxy_pass http://localhost:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}
```

When the proxy adds TLS, clients connect with `rr+wss` and the proxy's address. The Node.js server sees an ordinary `ws` connection, so `handleUpgrade` reports it as `rr+ws`. Use `acceptWebSocket` with a `wss` URL to report the address clients use.

## Origins

Browsers send the page's origin, and only the origins in `tcp.webSocketAllowedOrigins` may connect. It starts with Core's list. Add an origin, a wildcard such as `"https://*.example.com"`, or a scheme such as `"https://"` to allow every page using it, as Core does:

```js
tcp.webSocketAllowedOrigins.push("https://example.com");
```

Clients that are not browsers, such as Python or Core clients, send no origin and are not checked.
