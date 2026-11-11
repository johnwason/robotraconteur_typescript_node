<p align="center"><img src="docs/figures/logo-header.svg"></p>

# robotraconteur-node

Node.js additions for the [robotraconteur](https://github.com/robotraconteur/robotraconteur_typescript) TypeScript client: the `rr+tcp` transport, services, and discovery of nodes and services on the network. Browsers cannot use TCP sockets or UDP, so these live in a separate package and the browser library stays small.

> [!WARNING]
> This package is new, and its API may change in any release before 1.0. Pin an exact version, such as `robotraconteur-node@0.1.0`, and read the [changelog](CHANGELOG.md) before upgrading.

The client side of TCP, TLS (`rrs+tcp`), WebSockets, discovery, and subscriptions by service type are implemented. Services support properties, functions, generators, objrefs, events, callbacks, wires, pipes, authentication, and object and monitor locks, served over `rr+tcp` and `rr+ws`. Services can use TLS (`rrs+tcp`), can be announced for discovery, and can be hosted in an existing web server. Memories and the Local transport are not implemented yet.

Requires Node.js 22 or newer. `robotraconteur` is a peer dependency, so that both packages use one copy of it:

```
npm install robotraconteur robotraconteur-node
```

## Documentation

The [documentation](https://robotraconteur.github.io/robotraconteur_typescript_node/) has a guide and an API reference. The guide pages are also in this repository:

- [Getting started](docs/guide/getting-started.md): installing, and connecting over `rr+tcp` and `rr+ws`
- [Secure connections](docs/guide/tls.md): `rrs+tcp` for clients and services
- [Finding services](docs/guide/discovery.md): discovery, subscriptions by type, and announcing services
- [Writing services](docs/guide/services.md): serving JavaScript objects
- [Security and locks](docs/guide/security.md): logins, object locks, and monitor locks
- [Hosting in a web server](docs/guide/web-servers.md): Robot Raconteur WebSockets from Express, Next.js, and other servers

The client API is the one in `robotraconteur`, described in [its documentation](https://robotraconteur.github.io/robotraconteur_typescript/).

## Example: connecting over TCP

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

## Example: a service

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
const tcp = new TcpTransport(node);
node.registerTransport(tcp);
node.registerServiceType(definitionText);

await tcp.startServer(22222);
node.registerService("counter", "experimental.simple_counter.Counter", new Counter());
```

The [examples](https://github.com/robotraconteur/robotraconteur_typescript_node/tree/main/examples) folder has a complete service, a program that finds services on the network, and a web server that hosts a service.

## Developing

The shared package is used from a checkout in a folder next to this one, rather than from npm, so that both are developed together:

```sh
git clone https://github.com/robotraconteur/robotraconteur_typescript.git
git clone https://github.com/robotraconteur/robotraconteur_typescript_node.git
```

`npm run build` links it into `node_modules`, and `.npmrc` keeps npm from installing the published package in its place. All builds and tests run in a container. Build the images in `robotraconteur_typescript` first (see its README), along with its `Dockerfile.cpp-test-server` image, and build that package:

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
./scripts/podman-run.sh npm run docs
```

The tests reuse the shared package's client test suite over `rr+tcp` and `rr+ws`, against Core's Python test server by default or its C++ test server when selected as above. `npm run test:extra` connects to public test servers, as Core's extra tests do, so it needs internet access and is not part of `npm test`. It also tests `rrs+tcp` with real node certificates when `RR_NODE_CERTIFICATES` is set to a folder of two or more `{nodeid}.p12` files. Those include private keys, so they are not in this repository. The other `rrs+tcp` tests use a certificate authority made with openssl during the test.

Services are tested with ports of Core's Python test services in `test/service`, which read the same test vector blob as Core. Both the shared package's client tests and Core's own Python test clients run against them (`test/integration/CoreServiceTests.test.ts`). Core's clients come from the Core commit that the blob comes from, which the image and CI check out and `RR_CORE_PYTHON_TESTS` points to. Tests of features that services do not support yet are masked there by feature (Core's with `pytest -k`), so each new feature turns its tests on by removing its mask.

`npm run docs` builds the documentation site into `docs-site`.

## Releasing

1. Update the version in `package.json` and add the changes to [CHANGELOG.md](CHANGELOG.md). If it needs a newer release of `robotraconteur`, publish that first and update the peer dependency.
2. Publish a GitHub release in the robotraconteur organization, with a new tag named after the version, such as `v0.1.0`. The Publish workflow runs the tests, checks that the tag matches the version, and publishes to npm with provenance. It needs an npm token in the `NPM_TOKEN` secret of the repository.

## License

Apache 2.0
