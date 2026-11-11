// A Robot Raconteur service written in plain JavaScript. The object's properties, methods, and
// events are served by name, as in Python.
//
// 1. Build this package and the shared robotraconteur package:   npm run build
// 2. Run:   node examples/simple_service.mjs
// 3. Connect from any Robot Raconteur client, for example in Python:
//        from RobotRaconteur.Client import *
//        c = RRN.ConnectService("rr+tcp://localhost:22222?service=counter")
//        c.increment(5)
//        print(c.count)

import { RobotRaconteurNode } from "robotraconteur";
import { EventHook, TcpTransport } from "../dist/index.js";

const definition = `## A counter that clients can add to
service experimental.simple_counter

stdver 0.10

object Counter
    ## The current count
    property int32 count [readonly]
    ## Text shown with the count
    property string label
    ## Add to the count and return the new count
    function int32 increment(int32 amount)
    function void reset()
    ## Sent whenever the count changes
    event changed(int32 count)
end
`;

class Counter {
    count = 0;
    label = "Counter";
    // The node creates an EventHook for each event, but creating it here documents it
    changed = new EventHook();

    increment(amount) {
        this.count += amount;
        this.changed.fire(this.count);
        return this.count;
    }

    reset() {
        this.count = 0;
        this.changed.fire(this.count);
    }
}

const node = new RobotRaconteurNode();
node.nodeName = "simple_counter";
const tcp = new TcpTransport(node);
node.registerTransport(tcp);
node.registerServiceType(definition);

await tcp.startServer(22222);
node.registerService("counter", "experimental.simple_counter.Counter", new Counter());

console.log("Serving the counter at:");
for (const url of tcp.getServerListenUrls("counter")) console.log("    " + url);
console.log("Press Ctrl-C to stop");

process.on("SIGINT", async () => {
    await node.shutdown();
    process.exit(0);
});
