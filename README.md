# robotraconteur-node

Node.js additions for the [robotraconteur](https://github.com/johnwason/robotraconteur_typescript) TypeScript client: the `rr+tcp` transport and discovery of nodes and services on the network. Browsers cannot use TCP sockets or UDP, so these live in a separate package and the browser library stays small.

**Status:** early development. The client side of TCP and discovery is implemented. Services and servers, TLS (`rrs+tcp`), the Local transport, and subscriptions are not.

Requires Node.js 22 or newer.

## Installing

Neither package is on npm yet. This package needs the `node-split` branch of the shared package, in a folder next to this one:

```sh
git clone -b node-split https://github.com/johnwason/robotraconteur_typescript.git
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

## Finding services

```js
import { RobotRaconteurNode } from "robotraconteur";
import { connectServiceCandidates, NodeDiscovery, TcpTransport } from "robotraconteur-node";

const node = new RobotRaconteurNode();
const tcp = new TcpTransport(node);
node.registerTransport(tcp);

const discovery = new NodeDiscovery(node, tcp);
await discovery.start();

const services = await discovery.findServiceByType("experimental.reynard_the_robot.Reynard");
const reynard = await connectServiceCandidates(node, services[0].connectionURLs);
```

See [examples/find_service.mjs](examples/find_service.mjs) for a complete program.

| Function | Result |
| --- | --- |
| `discovery.findServiceByType(type, schemes?)` | Services whose root object has or implements `type`: `name`, `rootObjectType`, `rootObjectImplements`, `connectionURLs`, `attributes`, `nodeID`, `nodeName` |
| `discovery.findNodeByName(name, schemes?)`, `discovery.findNodeByID(id, schemes?)` | Nodes: `nodeID`, `nodeName`, `connectionURLs` |
| `discovery.detectedNodes` | Nodes currently known. This information has not been verified |
| `discovery.addNodeDetectedListener(fn)`, `discovery.addNodeLostListener(fn)` | Notifications, with matching remove functions. A node is lost one minute after its last announcement |
| `connectServiceCandidates(node, urls, username?, credentials?, objectType?)` | Connects using several URLs for one service and keeps the first that works |

Nodes are found using IPv6 link-local multicast by default, as in Core. Core services do not announce over IPv4 unless started with `--robotraconteur-tcp-ipv4-discovery=true`. To also search over IPv4:

```js
const discovery = new NodeDiscovery(node, tcp, {
    flags: IPNodeDiscoveryFlags.LinkLocal | IPNodeDiscoveryFlags.IPv4Broadcast
});
```

Discovery listens on UDP port 48653, and the firewall must allow it. Information from the network is unverified, so anything that acts on discovered services should check them against what it expects.

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
```

The tests reuse the shared package's client test suite over `rr+tcp`, against Core's Python test server by default or its C++ test server when selected as above.

## License

Apache 2.0
