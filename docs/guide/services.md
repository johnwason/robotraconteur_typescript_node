---
title: Writing services
---

# Writing services

A service is a plain JavaScript object, used the way Python uses one. The node serves its members by name, from a service definition registered on the node.

```js
import { RobotRaconteurNode } from "robotraconteur";
import { EventHook, TcpTransport } from "robotraconteur-node";

const definition = `## A counter that clients can add to
service experimental.simple_counter

stdver 0.10

object Counter
    ## The current count
    property int32 count [readonly]
    ## Add to the count and return the new count
    function int32 increment(int32 amount)
    ## Sent whenever the count changes
    event changed(int32 count)
end
`;

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
node.registerServiceType(definition);

await tcp.startServer(22222);
const context = node.registerService("counter", "experimental.simple_counter.Counter", new Counter());
```

`examples/simple_service.mjs` is a complete service. Clients connect with `rr+tcp://localhost:22222?service=counter`, or with `rr+ws` on the same port. `tcp.getServerListenUrls("counter")` lists the URLs. Browser pages may connect only from the origins in `tcp.webSocketAllowedOrigins`, which defaults to the same list as Core.

Register service definitions from their text, which is what clients receive, including its `##` documentation. Core rejects definitions whose entries are out of order, so `registerServiceType` checks the order of a definition given as text: `stdver`, then `import`, then `using`, then exceptions, constants, and enums, then structures and objects. `node.shutdown()` closes the services and the server.

## Members

| Member | Served as |
| --- | --- |
| `property` | The object's attribute, or a getter and setter |
| `function` | A method, which may return a promise |
| `event` | An {@link EventHook} on the object, which the node creates if the object does not have one. `fire(...)` sends the event to every client |
| `objref x` | The `get_x(index)` method, described below |
| `callback` | A {@link Callback} that the node puts on the object |
| `wire`, `pipe` | A {@link WireServer} or {@link PipeServer} that the node puts on the object, described below |

Values use the same types as clients receive. See the shared package's [Value types](https://robotraconteur.github.io/robotraconteur_typescript/documents/Value_types.html) page. A method named `RRServiceObjectInit(context, servicePath)` is called when the object is first served, with its {@link ServerContext}.

## Objrefs

An objref's `get_` method returns the object, or `[object, type]` when the object's type is not the declared one. That form is required for `varobject`. An objref without an index has `get_x()` with no argument.

```js
class Robot {
    get_tool(index) {
        return this.tools[index];
    }
}
```

Objects are kept once returned, so a client that asks again receives the same object. Call `context.releaseServicePath(path)` to have the objref asked again, which also closes clients' references to it and below it.

## Errors

Errors thrown by a method are returned to the client. Throw a `RobotRaconteurError` from the `robotraconteur` package to choose its name, and to add `errorSubName` or `errorParam`. Use the full name of an `exception` declared in a service definition, such as `experimental.simple_counter.CountTooLarge`, to have clients raise it. Other errors are returned as `RemoteError` with the JavaScript error name.

## Generators

A generator function returns the generator: anything iterable, such as an array or the result of a `function*` or `async function*`, or an object with `Next(param)` and optionally `Close()` and `Abort()`, as in Python.

```js
class Sensor {
    async *readings(count) {
        for (let i = 0; i < count; i++) yield await this.read();
    }
}
```

A function that takes a generator parameter receives its values through `Next(param)`. A generator is destroyed when it ends or fails, 30 seconds after the client closes or aborts it, and after 10 minutes without use, as in Core.

## Callbacks

`getClientFunction` returns an async function that calls the callback a client has set, as Python's `GetClientFunction`:

```js
import { ServerEndpoint } from "robotraconteur-node";

class Robot {
    async ask() {
        const confirm = this.confirm.getClientFunction(ServerEndpoint.current);
        return await confirm("Move the robot?");
    }
}
```

It also accepts a client's local endpoint number. The call fails with the client's error, if the client disconnects, or after the node's `requestTimeout`.

## Wires and pipes

The node puts a {@link WireServer} on each wire member and a {@link PipeServer} on each pipe member, by assigning it, so a setter on the object can keep it as in Python. Most services pass it to a helper:

```js
import { PipeBroadcaster, WireBroadcaster, WireUnicastReceiver } from "robotraconteur-node";

class Robot {
    set state(wire) {
        this.state_broadcaster = new WireBroadcaster(wire);
    }

    set command(wire) {
        this.command_receiver = new WireUnicastReceiver(wire);
        this.command_receiver.inValueChanged.addHandler((value) => this.move(value));
    }

    set frames(pipe) {
        this.frames_broadcaster = new PipeBroadcaster(pipe, 3);
    }

    update() {
        this.state_broadcaster.outValue = this.readState();
        void this.frames_broadcaster.sendPacket(this.readFrame());
    }
}
```

| Helper | Use |
| --- | --- |
| {@link WireBroadcaster} | Sends `outValue` to every client, including clients that connect later. `outValueLifespan` limits how long it stays valid, and `predicate` chooses clients |
| {@link WireUnicastReceiver} | Keeps the `inValue` from the latest client to connect and fires `inValueChanged` with the value, timestamp, and endpoint |
| {@link PipeBroadcaster} | Sends each packet to every endpoint, with Core's flow control: an endpoint is skipped while it has `maxBacklog` packets without acknowledgement |

For more control, set the server's `wireConnectCallback` or `pipeConnectCallback`. They receive a {@link WireConnection} (`inValue`, `outValue`, `wireValueChanged`) or a {@link PipeEndpoint} (`sendPacket`, `receivePacket`, `packetReceivedEvent`). Wire peeks and pokes go to `peekInValueCallback`, `peekOutValueCallback`, and `pokeOutValueCallback`.

## The client being served

{@link ServerEndpoint.current} is the client whose request is being served, including after `await` in the same request. It has the client's `remoteNodeID`, `remoteNodeName`, and `authenticatedUser`. `ServerEndpoint.currentAuthenticatedUser` is the user of the request, as described in [Security and locks](security.md).

## The service context

`registerService` returns the {@link ServerContext}:

| Member | Use |
| --- | --- |
| `attributes` | A `Map` of `VarValue` sent to clients and to discovery, such as `context.attributes.set("vendor", new VarValue("example", "string"))` |
| `addExtraImport(name)` | Send another registered service definition to clients |
| `releaseServicePath(path)` | Forget an objref's object, as above |
| `clientEndpoints`, `getClient(endpoint)` | The connected clients |
| `addServerServiceListener(fn)` | Notifications when clients connect and disconnect |
| `close()` | Stop the service and disconnect its clients |
| `decodeOptions` | How values from clients are decoded, described below |
| `newNamedArrayView(type, countOrArray)` | Create a view to send, described below |

## Large arrays

Arrays of named arrays, such as the points of a point cloud, are received as an `Array` of objects, which is slow for millions of elements. Set the service's `decodeOptions` to receive them as a `NamedArrayView` over the typed array that was received instead, as clients can:

```js
const context = node.registerService("sensor", "experimental.sensor.Sensor", sensor);
context.decodeOptions = { viewTypes: ["com.robotraconteur.geometry.Vector3"] };
```

This applies to function parameters, property values, and wire and pipe values from clients. The node's `decodeOptions` are for its clients and do not change how services decode.

A service can send a `NamedArrayView` wherever an array of its named array type is expected, without copying. `context.newNamedArrayView(type, countOrArray)` creates one, zeroed or over a typed array of the type's number type:

```js
const points = context.newNamedArrayView("com.robotraconteur.geometry.Vector3", 1000);
points.array[0] = 1.5; // x of point 0
```

See the shared package's [Value types](https://robotraconteur.github.io/robotraconteur_typescript/documents/Value_types.html#large-arrays) page for the layout of a view.

## Not supported yet

Memories and the Local transport are not supported by services yet.
