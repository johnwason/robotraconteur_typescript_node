# Changelog

The API may change in any release before 1.0.

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
