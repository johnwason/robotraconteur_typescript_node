<p align="center"><img src="docs/figures/logo-header.svg"></p>

# robotraconteur-node

Node.js additions for the [robotraconteur](https://github.com/johnwason/robotraconteur_typescript) TypeScript client: the `rr+tcp` transport, services, and discovery of nodes and services on the network. Browsers cannot use TCP sockets or UDP, so these live in a separate package and the browser library stays small.

**Status:** early development. The client side of TCP, TLS (`rrs+tcp`), WebSockets, discovery, and subscriptions by service type are implemented. Services support properties, functions, generators, objrefs, events, and callbacks, served over `rr+tcp` and `rr+ws`. Wires, pipes, memories, authentication, locks, TLS for services, announcing services for discovery, and the Local transport are not implemented yet.

Requires Node.js 22 or newer.

## Installing

Neither package is on npm yet. This package needs the shared package in a folder next to this one:

```sh
git clone https://github.com/johnwason/robotraconteur_typescript.git
git clone https://github.com/johnwason/robotraconteur_typescript_node.git

cd robotraconteur_typescript
npm install
npm run build

cd ../robotraconteur_typescript_node
npm install
npm run build
```

## Connecting over TCP

The API is the one in `robotraconteur`, with one more transport registered:

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

## Secure connections

`rrs+tcp` URLs use TLS, checking the service's Robot Raconteur node certificate as Core does. The certificate must lead to one of the Robot Raconteur root certificates built into Core, and must be for the node that answers, or for the node named in the URL. Naming the node ID in the URL is the way to be sure of which node you are talking to.

```js
const reynard = await node.connectService("rrs+tcp://localhost:29200?nodeid=e4605d17-ed15-4052-895f-30927eb1623a&service=reynard");
```

`tlsOptions` sets where trust comes from, and a certificate for this node if the service checks clients:

```js
const tcp = new TcpTransport(node);
tcp.tlsOptions = {
    // A site's own certificate authority, in place of the built-in roots
    trustedRoots: [readFileSync("site-root.pem")],
    useDefaultRoots: false,
    // This node's certificate and key. The node ID must match the certificate
    clientCertificate: { pfx: readFileSync("{e51a88ce-0c8f-4792-867e-5386ec6e654b}.p12") }
};
node.nodeID = new NodeID("{e51a88ce-0c8f-4792-867e-5386ec6e654b}");
node.registerTransport(tcp);
```

To load this node's certificate from where Core keeps it, `certificates/{nodeid}.p12` in Core's configuration folder (`~/.config/RobotRaconteur` on Linux and macOS, `%LOCALAPPDATA%\RobotRaconteur` on Windows), set the node ID and call `loadTlsNodeCertificate()`. As in Core, the PEM file named by `ROBOTRACONTEUR_SSL_CERT_FILE` and the folder named by `ROBOTRACONTEUR_SSL_CERT_DIR` add trusted roots.

Discovery looks for both `rr+tcp` and `rrs+tcp` URLs. When a node offers both, `rrs+tcp` is tried first and `rr+tcp` shortly after, as in Core, and whichever connects first is used. To use only TLS, set `transportSchemes: ["rrs+tcp"]` in a subscription filter, or `requireTls` on the transport.

Set `tcp.requireTls = true` to refuse any URL other than `rrs+tcp`. For a connected client, `tcp.isTransportConnectionSecure(client)` and `tcp.isSecurePeerIdentityVerified(client)` report whether it uses TLS with a verified certificate, and `tcp.getSecurePeerIdentity(client)` returns the verified node ID.

Node certificates mark each level of their chain with a critical extension that OpenSSL does not recognize, so the TLS module of Node.js rejects all of them. The package turns its check off and checks the chain itself before anything else is sent: signatures, dates, certificate authority flags and path lengths, the Robot Raconteur extension for each level, and the node named in the certificate. `verifyNodeCertificate` performs the same check on its own.

## Finding services

```js
import { RobotRaconteurNode } from "robotraconteur";
import { NodeDiscovery, TcpTransport } from "robotraconteur-node";

const node = new RobotRaconteurNode();
const tcp = new TcpTransport(node);
node.registerTransport(tcp);

const discovery = new NodeDiscovery(node, tcp);
await discovery.start();

const services = await discovery.findServiceByType("experimental.reynard_the_robot.Reynard");
const reynard = await node.connectService(services[0].connectionURLs);
```

See [examples/find_service.mjs](examples/find_service.mjs) for a complete program.

| Function | Result |
| --- | --- |
| `discovery.findServiceByType(type, schemes?)` | Services whose root object has or implements `type`: `name`, `rootObjectType`, `rootObjectImplements`, `connectionURLs`, `attributes`, `nodeID`, `nodeName` |
| `discovery.findNodeByName(name, schemes?)`, `discovery.findNodeByID(id, schemes?)` | Nodes: `nodeID`, `nodeName`, `connectionURLs` |
| `discovery.detectedNodes` | Nodes currently known. This information has not been verified |
| `discovery.addNodeDetectedListener(fn)`, `discovery.addNodeLostListener(fn)` | Notifications, with matching remove functions. A node is lost one minute after its last announcement |

Nodes are found using IPv6 link-local multicast by default, as in Core. Core services do not announce over IPv4 unless started with `--robotraconteur-tcp-ipv4-discovery=true`. To also search over IPv4:

```js
const discovery = new NodeDiscovery(node, tcp, {
    flags: IPNodeDiscoveryFlags.LinkLocal | IPNodeDiscoveryFlags.IPv4Broadcast
});
```

Discovery listens on UDP port 48653, and the firewall must allow it. Information from the network is unverified, so anything that acts on discovered services should check them against what it expects.

## Subscriptions

A subscription finds services and keeps them connected. Subscriptions to a known URL are in the `robotraconteur` package, using `subscribeService`, and work in browsers. Finding services by type needs discovery, so that is here:

```js
const subscription = discovery.subscribeServiceByType("experimental.reynard_the_robot.Reynard", {
    serviceNames: ["reynard"]
});

const state = subscription.subscribeWire("state");
await state.waitInValueValid();
console.log(state.getInValue().value.robot_position);

const reynard = await subscription.getDefaultClientWait(5000);
await reynard.callFunction("say", ["Hello!"]);

subscription.close();
```

A `ServiceSubscriptionManager` keeps a set of named subscriptions, for applications that connect to several services or read them from a configuration. Each one connects by URL, or by service type and filter. A name keeps the same subscription when it is disabled, enabled, or changed, so wires and pipes on it keep working.

```js
const manager = new ServiceSubscriptionManager(discovery);
manager.addSubscription({ name: "reynard", serviceTypes: ["experimental.reynard_the_robot.Reynard"] });
manager.addSubscription({ name: "arm", urls: ["rr+tcp://localhost:52701?service=robot"], enabled: false });

const reynard = await manager.getSubscription("reynard").getDefaultClientWait(5000);
manager.enableSubscription("arm");
manager.disableSubscription("reynard");
manager.updateSubscription({ name: "arm", urls: ["rr+tcp://localhost:52702?service=robot"] });

manager.close();
```

The wire, pipe, and client functions are described in the [robotraconteur README](https://github.com/johnwason/robotraconteur_typescript/tree/dev#staying-connected). A subscription keeps the program running until it is closed or `node.shutdown()` is called.

The filter passed as the second argument has these optional fields:

| Field | Meaning |
| --- | --- |
| `nodes` | Allowed nodes, as `{ nodeID, nodeName, username, credentials }`. Unset identifiers match any node |
| `serviceNames` | Allowed service names |
| `transportSchemes` | Allowed URL schemes, such as `rr+tcp` |
| `attributes` | Conditions on the service attributes, as an object or `Map` from attribute name to a group, described below |
| `attributesMatchOperation` | How the conditions combine: `"and"` (the default), `"or"`, `"nor"`, or `"nand"` |
| `predicate` | A function that receives the service information and returns whether to use it |
| `maxConnections` | The most services to connect to at once. Zero or unset for no limit |

Attribute conditions behave as in Core:

```js
import {
    createServiceSubscriptionFilterAttributeIdentifier,
    createServiceSubscriptionFilterAttributeRegex,
    ServiceSubscriptionFilterAttribute,
    ServiceSubscriptionFilterAttributeGroup
} from "robotraconteur-node";

const subscription = discovery.subscribeServiceByType("com.robotraconteur.robotics.robot.Robot", {
    attributes: {
        // Any one of these values
        vendor: new ServiceSubscriptionFilterAttributeGroup("or", [
            new ServiceSubscriptionFilterAttribute("abb"),
            createServiceSubscriptionFilterAttributeRegex("universal.*")
        ]),
        // An identifier written as "name|uuid", matching by name alone here
        device: new ServiceSubscriptionFilterAttributeGroup("and", [
            createServiceSubscriptionFilterAttributeIdentifier("left_arm", "")
        ])
    }
});
```

A group combines its attributes and any nested groups with `"or"` (the default), `"and"`, `"nor"`, or `"nand"`. A string attribute is split at commas into a list of values, unless the group's `splitStringAttribute` is `false`, and a value in the list only has to match one attribute of an `"or"` group. List and map attributes are matched by their string values, and `new ServiceSubscriptionFilterAttribute("key", "value")` matches one entry of a map. A regular expression must match the entire value. A missing attribute counts as an empty list, which matches an empty group or a `"nor"` group.

Without a filter, a subscription tries every service of the type, including any that need a password. A service that fails to connect 25 times in a row is dropped until it is announced again.

`discovery.subscribeServiceInfo2(types, filter)` tracks services without connecting to them, with `getDetectedServiceInfo2()`, `addServiceDetectedListener`, and `addServiceLostListener`.

## Services

A service is a plain object, used the way Python uses one. Properties are read and written as its attributes, functions call its methods, which may return a promise, and an objref named `x` calls its `get_x(index)` method. The node puts an `EventHook` on each event member that does not have one, and the service sends the event to its clients with `fire()`. A method named `RRServiceObjectInit(context, servicePath)` is called when the object is first served.

```js
import { RobotRaconteurNode } from "robotraconteur";
import { EventHook, TcpTransport } from "robotraconteur-node";

class Counter {
    count = 0;
    changed = new EventHook();

    increment(amount) {
        this.count += amount;
        this.changed.fire(this.count);
        return this.count;
    }
}

const node = new RobotRaconteurNode();
node.nodeName = "simple_counter";
const tcp = new TcpTransport(node);
node.registerTransport(tcp);
node.registerServiceType(definitionText);

await tcp.startServer(22222);
node.registerService("counter", "experimental.simple_counter.Counter", new Counter());
```

[examples/simple_service.mjs](examples/simple_service.mjs) is a complete service. Register service definitions from their text, which is what clients receive, including its `##` documentation. Clients connect with `rr+tcp://localhost:22222?service=counter`, or with `rr+ws` on the same port. Browser pages may connect only from the origins in `tcp.webSocketAllowedOrigins`, which defaults to the same list as Core.

Some details follow Core and Python:

- An objref's `get_` method returns the object, or `[object, type]` when the object's type is not the declared one. That form is required for `varobject`. Objects are kept once returned. Call `context.releaseServicePath(path)` to have the objref asked again.
- Errors thrown by a method are returned to the client. Throw a `RobotRaconteurError` to choose its name, and to add `errorSubName` or `errorParam`. Other errors are returned as `RemoteError` with the JavaScript error name.
- A generator function returns the generator: anything iterable, such as an array or the result of a `function*` or `async function*`, or an object with `Next(param)` and optionally `Close()` and `Abort()`, as in Python. A function that takes a generator parameter receives its values through `Next(param)`. A generator is destroyed when it ends or fails, 30 seconds after the client closes or aborts it, and after 10 minutes without use, as in Core.
- The node puts a `Callback` on each callback member. `this.cb.getClientFunction(ServerEndpoint.current)` returns an async function that calls the callback the client has set, as Python's `GetClientFunction`. It also accepts a client's local endpoint number. The call fails with the client's error, if the client disconnects, or after the node's `requestTimeout`.
- `ServerEndpoint.current` is the client whose request is being served, including after `await` in the same request.
- `registerService` returns the `ServerContext`, which holds the service `attributes` sent to clients, `addExtraImport`, `releaseServicePath`, and `close()`.

## Developing

All builds and tests run in a container. Build the images in `robotraconteur_typescript` first (see its README), along with its `Dockerfile.cpp-test-server` image, and build that package:

```sh
cd ../robotraconteur_typescript
podman build -t rr-ts-dev .
podman build -f Dockerfile.cpp-test-server -t rr-ts-dev-cpp .
./scripts/podman-run.sh npm run build

cd ../robotraconteur_typescript_node
podman build -t rr-ts-node-dev .
./scripts/podman-run.sh npm test
RR_TEST_SERVER_SCRIPT=test/server/rr_cpp_test_server.py ./scripts/podman-run.sh npm test
./scripts/podman-run.sh npm run test:extra
```

The tests reuse the shared package's client test suite over `rr+tcp` and `rr+ws`, against Core's Python test server by default or its C++ test server when selected as above. `npm run test:extra` connects to public test servers, as Core's extra tests do, so it needs internet access and is not part of `npm test`. It also tests `rrs+tcp` with real node certificates when `RR_NODE_CERTIFICATES` is set to a folder of two or more `{nodeid}.p12` files. Those include private keys, so they are not in this repository. The other `rrs+tcp` tests use a certificate authority made with openssl during the test.

Services are tested with ports of Core's Python test services in `test/service`, which read the same test vector blob as Core. Both the shared package's client tests and Core's own Python test clients run against them (`test/integration/CoreServiceTests.test.ts`). Core's clients come from the Core commit that the blob comes from, which the image and CI check out and `RR_CORE_PYTHON_TESTS` points to. Tests of features that services do not support yet are masked there by feature (Core's with `pytest -k`), so each new feature turns its tests on by removing its mask.

## License

Apache 2.0
