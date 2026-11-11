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

// Services on WebSockets accepted by the application's own web server, as RobotRaconteurWeb
// accepts them from ASP.NET.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { RobotRaconteurNode } from "robotraconteur";
import { WebSocketServer } from "ws";
import { ServerEndpoint, TcpTransport } from "../../src/index.js";
import { TestCertificates } from "../common/TestCertificates.js";
import { PYTHON } from "./TestServer.js";

const DEF = `service experimental.ws_hosting_test

object testobj
    function double add_two_numbers(double a, double b)
    function bool secure()
end
`;

function listen(server: HttpServer): Promise<number>
{
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

describe("WebSockets accepted by the application's web server", () =>
{
    const node = new RobotRaconteurNode();
    node.nodeName = "ts_ws_hosting";
    const tcp = new TcpTransport(node);
    node.registerTransport(tcp);
    node.registerServiceType(DEF);
    node.registerService("testobj", "experimental.ws_hosting_test.testobj", {
        add_two_numbers: (a: number, b: number) => a + b,
        secure: () => tcp.isTransportConnectionSecure(ServerEndpoint.current!)
    });

    const certs = new TestCertificates();
    // An ordinary web certificate authority and server certificate, as a site would have, without
    // the Robot Raconteur extensions that ordinary TLS rejects
    const ca = certs.root("web_root", { level: null });
    const web = certs.issue("web", "/CN=localhost", ca, { level: null, extra: ["subjectAltName=DNS:localhost,IP:127.0.0.1", "extendedKeyUsage=serverAuth"] });

    // A web site with a page and Robot Raconteur on /robotraconteur, as the ASP.NET wstest server
    const site = (req: { url?: string }, res: { writeHead(s: number): void; end(t?: string): void }) =>
    {
        if (req.url === "/") res.end("Robot Raconteur Node.js Web Socket Test Server");
        else
        {
            res.writeHead(404);
            res.end();
        }
    };
    const http = createHttpServer(site);
    const https = createHttpsServer({ key: readFileSync(web.keyFile, "utf8"), cert: web.pem }, site);
    for (const s of [http, https])
    {
        s.on("upgrade", (req, socket, head) =>
        {
            if (req.url?.split("?")[0] === "/robotraconteur") void tcp.handleUpgrade(req, socket, head);
            else socket.destroy();
        });
    }

    // An application that accepts the WebSocket itself, with the ws library
    const own = createHttpServer(site);
    const own_wss = new WebSocketServer({ noServer: true, handleProtocols: (p) => (p.has("robotraconteur.robotraconteur.com") ? "robotraconteur.robotraconteur.com" : false) });

    let http_port = 0;
    let https_port = 0;
    let own_port = 0;

    const client = new RobotRaconteurNode();
    const client_tcp = new TcpTransport(client);
    client_tcp.webSocketOptions = { ca: ca.pem };
    client.registerTransport(client_tcp);

    before(async () =>
    {
        http_port = await listen(http);
        https_port = await listen(https as unknown as HttpServer);
        own_port = await listen(own);
        own.on("upgrade", (req, socket, head) => own_wss.handleUpgrade(req, socket, head, (ws) => void tcp.acceptWebSocket(ws, `ws://127.0.0.1:${own_port}/rr`)));
    });

    after(async () =>
    {
        await client.shutdown();
        await node.shutdown();
        for (const s of [http, https, own]) s.close();
        own_wss.close();
        certs.close();
    });

    test("the site serves its pages and Robot Raconteur on the same port", async () =>
    {
        assert.equal(await (await fetch(`http://127.0.0.1:${http_port}/`)).text(), "Robot Raconteur Node.js Web Socket Test Server");
        const c = await client.connectService(`rr+ws://127.0.0.1:${http_port}/robotraconteur?service=testobj`);
        assert.equal(await c.callFunction("add_two_numbers", [2, 3]), 5);
        assert.equal(await c.callFunction("secure"), false);
        await client.disconnectService(c);
    });

    test("the service index reports the URL of the request", async () =>
    {
        const index = await client.connectService(`rr+ws://127.0.0.1:${http_port}/robotraconteur?service=RobotRaconteurServiceIndex`);
        const services = await index.callFunction("GetLocalNodeServices") as Map<number, { Name: string; ConnectionURL: Map<number, string> }>;
        const s = [...services.values()].find((x) => x.Name === "testobj")!;
        const id = node.nodeID.toString().replace(/[{}]/g, "");
        assert.equal(s.ConnectionURL.get(1), `rr+ws://127.0.0.1:${http_port}/robotraconteur?nodeid=${id}&service=testobj`);
        await client.disconnectService(index);
    });

    test("origins and subprotocols are checked as Core does", async () =>
    {
        const other = new RobotRaconteurNode();
        const t = new TcpTransport(other);
        other.registerTransport(t);
        try
        {
            t.webSocketOptions = { headers: { Origin: "http://example.org" } };
            await assert.rejects(other.connectService(`rr+ws://127.0.0.1:${http_port}/robotraconteur?service=testobj`), /403/);
        }
        finally
        {
            await other.shutdown();
        }
    });

    test("an https server gives rr+wss connections, which are secure", async () =>
    {
        const c = await client.connectService(`rr+wss://localhost:${https_port}/robotraconteur?service=testobj`);
        assert.equal(await c.callFunction("add_two_numbers", [1, 1]), 2);
        assert.equal(await c.callFunction("secure"), true);
        await client.disconnectService(c);
    });

    test("acceptWebSocket serves a WebSocket the application accepted", async () =>
    {
        const c = await client.connectService(`rr+ws://127.0.0.1:${own_port}/rr?service=testobj`);
        assert.equal(await c.callFunction("add_two_numbers", [4, 5]), 9);
        await client.disconnectService(c);
        const index = await client.connectService(`rr+ws://127.0.0.1:${own_port}/rr?service=RobotRaconteurServiceIndex`);
        const services = await index.callFunction("GetLocalNodeServices") as Map<number, { Name: string; ConnectionURL: Map<number, string> }>;
        assert.ok([...services.values()].find((x) => x.Name === "testobj")!.ConnectionURL.get(1)!.startsWith(`rr+ws://127.0.0.1:${own_port}/rr?nodeid=`));
        await client.disconnectService(index);
    });

    test("Core's Python client connects to the site", { timeout: 60000 }, async () =>
    {
        const code = "import sys\nfrom RobotRaconteur.Client import *\nc = RRN.ConnectService(sys.argv[1])\nprint(c.add_two_numbers(2.0, 3.0))";
        const { stdout } = await promisify(execFile)(PYTHON, ["-c", code, `rr+ws://127.0.0.1:${http_port}/robotraconteur?service=testobj`], { timeout: 50000 });
        assert.equal(stdout.trim(), "5.0");
    });
});
