# Changelog

The API may change in any release before 1.0.

## 0.1.1

* Bug fixes in the service (sessions, locks and requests), wires and pipes, transports, discovery and node directories, several of them the same fixes as in Robot Raconteur Core 1.3.0.
* Behavior changes:
  * A special request must be the only entry in its message; otherwise the connection is closed.
  * Service definitions are verified when they are registered, as in Core.
  * Every spelling of a service path index refers to the same object.
  * Monitor operations require authentication on services that require a valid user.
  * The `allowobjectlock` security policy is enforced.
  * Generators that are destroyed without being closed are aborted.
  * Reliable pipes keep at most 1024 out-of-order packets.
  * `chrome-extension://` and plain `http://` origins are no longer allowed by default for WebSocket connections.
* Require robotraconteur 0.1.1 or later as the peer dependency, for its fixes.
* Export `./package.json`, so that tools can read the package's version with `require("robotraconteur-node/package.json")`.

## 0.1.0

The first release: Node.js additions for the [robotraconteur](https://github.com/robotraconteur/robotraconteur_typescript) client, which is a peer dependency.

* `TcpTransport` for `rr+tcp`, and for `rr+ws` and `rr+wss` using the ws package, with flow control.
* `rrs+tcp` with TLS. Robot Raconteur node certificates are verified as Core does, against the roots built into Core or a site's own. Client certificates, `requireTls`, and loading the node certificate from Core's configuration folder are supported.
* Discovery of nodes using IPv6 link-local multicast as in Core, with optional IPv4 broadcast, and finding services and nodes.
* Subscriptions by service type with Core's filters, including attribute filters, and `ServiceSubscriptionManager`.
* Services that serve plain JavaScript objects: properties, functions, generators, object references, events, callbacks, wires, and pipes, with `WireBroadcaster`, `WireUnicastReceiver`, and `PipeBroadcaster`.
* Service security with `ServiceSecurityPolicy` and Core's password files, object locks, and monitor locks.
* Services over `rrs+tcp`, announced for discovery with the service index, and hosted in an existing web server with `handleUpgrade` or `acceptWebSocket`.
* Services can receive and send arrays of named arrays as `NamedArrayView`.
* A user guide and API reference at https://robotraconteur.github.io/robotraconteur_typescript_node/

Not included: memories and the Local transport.
