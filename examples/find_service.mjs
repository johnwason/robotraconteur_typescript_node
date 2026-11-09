// Finds Robot Raconteur services on the network and connects to one of them.
//
// 1. Build this package and the shared robotraconteur package:   npm run build
// 2. Run:   node examples/find_service.mjs experimental.reynard_the_robot.Reynard
//    A service name can be added after the type, to choose between several services of that type.

import { RobotRaconteurNode } from "robotraconteur";
import { NodeDiscovery, TcpTransport } from "../dist/index.js";

const [serviceType, serviceName] = process.argv.slice(2);
if (!serviceType) {
    console.error("Usage: node examples/find_service.mjs <fully qualified object type> [service name]");
    process.exit(1);
}

const node = new RobotRaconteurNode();
const tcp = new TcpTransport(node);
node.registerTransport(tcp);

const discovery = new NodeDiscovery(node, tcp);
await discovery.start();

const services = await discovery.findServiceByType(serviceType);
for (const service of services) {
    console.log(`Found ${service.name} on node ${service.nodeName}`);
}

const service = serviceName ? services.find((s) => s.name === serviceName) : services[0];
if (service) {
    const client = await node.connectService(service.connectionURLs);
    console.log("Connected to object of type", client.objectType);
    await node.disconnectService(client);
}

discovery.close();
await node.shutdown();
