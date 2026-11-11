---
title: Finding services
---

# Finding services

Robot Raconteur nodes announce themselves on the local network over UDP. {@link NodeDiscovery} listens for the announcements, asks each node which services it has, and finds services by type.

## Finding a service by type

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

See `examples/find_service.mjs` for a complete program.

| Function | Result |
| --- | --- |
| `discovery.findServiceByType(type, schemes?)` | {@link ServiceInfo2} for services whose root object has or implements `type`: `name`, `rootObjectType`, `rootObjectImplements`, `connectionURLs`, `attributes`, `nodeID`, `nodeName` |
| `discovery.findNodeByName(name, schemes?)`, `discovery.findNodeByID(id, schemes?)` | {@link NodeInfo2}: `nodeID`, `nodeName`, `connectionURLs` |
| `discovery.detectedNodes` | Nodes currently known. This information has not been verified |
| `discovery.addNodeDetectedListener(fn)`, `discovery.addNodeLostListener(fn)` | Notifications, with matching remove functions. A node is lost one minute after its last announcement |

Nodes are found using IPv6 link-local multicast by default, as in Core. Core services do not announce over IPv4 unless started with `--robotraconteur-tcp-ipv4-discovery=true`. To also search over IPv4:

```js
const discovery = new NodeDiscovery(node, tcp, {
    flags: IPNodeDiscoveryFlags.LinkLocal | IPNodeDiscoveryFlags.IPv4Broadcast
});
```

Discovery listens on UDP port 48653, and the firewall must allow it. Information from the network is unverified, so anything that acts on discovered services should check them against what it expects.

## Subscriptions by type

A subscription finds services and keeps them connected. Subscriptions to a known URL are in the `robotraconteur` package and are described in its [Staying connected](https://robotraconteur.github.io/robotraconteur_typescript/documents/Staying_connected.html) page. Subscriptions by type are here:

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

A subscription keeps the program running until it is closed or `node.shutdown()` is called. Without a filter, it tries every service of the type, including any that need a password. A service that fails to connect 25 times in a row is dropped until it is announced again.

A third argument sets the subscription's options, such as `connectRetryDelay` and `decodeOptions`. Decode options can receive large arrays of named arrays, such as point clouds, as typed array views, as described in the shared package's [Value types](https://robotraconteur.github.io/robotraconteur_typescript/documents/Value_types.html#large-arrays) page:

```js
const subscription = discovery.subscribeServiceByType("com.robotraconteur.pointcloud.sensor.PointCloudSensor", undefined, {
    decodeOptions: { viewTypes: ["com.robotraconteur.pointcloud.PointCloudPointf"] }
});
```

`discovery.subscribeServiceInfo2(types, filter)` tracks services without connecting to them, with `getDetectedServiceInfo2()`, `addServiceDetectedListener`, and `addServiceLostListener`.

## Filters

The {@link ServiceSubscriptionFilter} passed as the second argument has these optional fields:

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

## Managing several subscriptions

A {@link ServiceSubscriptionManager} keeps a set of named subscriptions, for applications that connect to several services or read them from a configuration. Each one connects by URL, or by service type and filter. A name keeps the same subscription when it is disabled, enabled, or changed, so wires and pipes on it keep working.

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

A subscription's details can also include `decodeOptions`, which an update changes for its connected clients.

## Announcing services

A node that serves announces itself so that clients can find its services by type, as Core's `EnableNodeAnnounce` does:

```js
await tcp.startServer(22222);
node.registerService("counter", "experimental.simple_counter.Counter", new Counter());
await tcp.enableNodeAnnounce();
```

It uses Core's IPv6 node-local, link-local, and site-local multicast by default. Pass {@link IPNodeDiscoveryFlags} for IPv4 broadcast. The node announces each local address 0.5 seconds after starting, every 55 seconds after that ({@link TcpTransport.nodeAnnouncePeriod}), soon after its services change, and when another node sends a discovery request. `rrs+tcp` is announced too when the node has its TLS certificate.

Clients list the services with the node's `RobotRaconteurServiceIndex` service, which the node serves once it has a service, as in Core. `node.serviceStateNonce` changes whenever services are registered or closed, so that clients know to list them again. Only string and numeric array attributes are reported to discovery, as in Core.
