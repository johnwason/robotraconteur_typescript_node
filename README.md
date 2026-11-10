# robotraconteur-node

Node.js additions for the [robotraconteur](https://github.com/johnwason/robotraconteur_typescript) TypeScript client: the `rr+tcp` transport and discovery of nodes and services on the network. Browsers cannot use TCP sockets or UDP, so these live in a separate package and the browser library stays small.

**Status:** early development. The client side of TCP, discovery, and subscriptions by service type are implemented. Services and servers, TLS (`rrs+tcp`), and the Local transport are not.

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

The wire, pipe, and client functions are described in the [robotraconteur README](https://github.com/johnwason/robotraconteur_typescript/tree/node-split#staying-connected). A subscription keeps the program running until it is closed or `node.shutdown()` is called.

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
