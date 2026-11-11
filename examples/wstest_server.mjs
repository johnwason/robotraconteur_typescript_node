// The Robot Raconteur WebSocket test server, in Node.js. It is the same as the ASP.NET wstest server
// for RobotRaconteurWeb: a web server with a page on / and Robot Raconteur WebSockets on
// /robotraconteur, serving experimental.wstest. The web server is Node.js's own http module, which
// Express, Fastify, and Next.js custom servers also run on.
//
// 1. Build this package and the shared robotraconteur package:   npm run build
// 2. Run:   node examples/wstest_server.mjs        (PORT sets the port, 8080 by default)
// 3. Connect from any Robot Raconteur client, for example in Python:
//        from RobotRaconteur.Client import *
//        c = RRN.ConnectService("rr+ws://localhost:8080/robotraconteur?service=testobj")
//        print(c.add_two_numbers(2, 3))
//    Behind a server that adds TLS, such as nginx or IIS, clients use rr+wss with its address.

import { createServer } from "node:http";
import { RobotRaconteurNode } from "robotraconteur";
import { TcpTransport } from "../dist/index.js";

const definition = `service experimental.wstest

object testobj
    function double add_two_numbers(double a, double b)
end object
`;

class testobj_impl {
    add_two_numbers(a, b) {
        return a + b;
    }
}

const node = new RobotRaconteurNode();
node.nodeName = "wstest";
const tcp = new TcpTransport(node);
// As the ASP.NET server, accept pages from any origin. Core's rules allow an origin by its scheme
tcp.webSocketAllowedOrigins.push("http://", "https://");
node.registerTransport(tcp);
node.registerServiceType(definition);
node.registerService("testobj", "experimental.wstest.testobj", new testobj_impl());

const server = createServer((req, res) => {
    if (req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Robot Raconteur Node.js Web Socket Test Server");
    } else {
        res.writeHead(404);
        res.end();
    }
});

// Receive WebSockets on /robotraconteur
server.on("upgrade", (req, socket, head) => {
    if (req.url?.split("?")[0] === "/robotraconteur") void tcp.handleUpgrade(req, socket, head);
    else socket.destroy();
});

const port = Number(process.env.PORT ?? 8080);
server.listen(port, () => console.log(`Serving the wstest service at rr+ws://localhost:${port}/robotraconteur?service=testobj`));

const stop = async () => {
    server.close();
    await node.shutdown();
    process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
