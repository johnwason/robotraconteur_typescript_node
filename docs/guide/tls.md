---
title: Secure connections
---

# Secure connections

`rrs+tcp` URLs use TLS, with the Robot Raconteur node certificates that Core uses.

## Connecting to a service

The service's certificate is checked as Core does. It must lead to one of the Robot Raconteur root certificates built into Core, and must be for the node that answers, or for the node named in the URL. Naming the node ID in the URL is the way to be sure of which node you are talking to.

```js
const reynard = await node.connectService("rrs+tcp://localhost:29200?nodeid=e4605d17-ed15-4052-895f-30927eb1623a&service=reynard");
```

{@link TlsClientOptions} sets where trust comes from, and a certificate for this node if the service checks clients:

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

To load this node's certificate from where Core keeps it, `certificates/{nodeid}.p12` in Core's configuration folder (`~/.config/RobotRaconteur` on Linux and macOS, `%LOCALAPPDATA%\RobotRaconteur` on Windows), set the node ID and call {@link TcpTransport.loadTlsNodeCertificate}. As in Core, the PEM file named by `ROBOTRACONTEUR_SSL_CERT_FILE` and the folder named by `ROBOTRACONTEUR_SSL_CERT_DIR` add trusted roots.

Set `tcp.requireTls = true` to refuse any URL other than `rrs+tcp`. For a connected client, `tcp.isTransportConnectionSecure(client)` and `tcp.isSecurePeerIdentityVerified(client)` report whether it uses TLS with a verified certificate, and `tcp.getSecurePeerIdentity(client)` returns the verified node ID.

Discovery looks for both `rr+tcp` and `rrs+tcp` URLs. When a node offers both, `rrs+tcp` is tried first and `rr+tcp` shortly after, as in Core, and whichever connects first is used. To use only TLS, set `transportSchemes: ["rrs+tcp"]` in a subscription filter, or `requireTls` on the transport.

## Services

Services accept `rrs+tcp` once the node has its certificate, in `tlsOptions.clientCertificate` or from `loadTlsNodeCertificate()`. The service presents the certificate after the client's STARTTLS, as Core's does, and checks the client's certificate if the client asks for mutual authentication.

Inside a request, these report on the client's connection:

```js
const ep = ServerEndpoint.current;
tcp.isTransportConnectionSecure(ep);    // TLS in use
tcp.isSecurePeerIdentityVerified(ep);   // the client's certificate was checked
tcp.getSecurePeerIdentity(ep);          // the client's verified node ID
```

With `requireTls`, the server closes connections that do not start TLS. `new PasswordFileUserAuthenticator(text, true)` lets users log in only from verified clients, as described in [Security and locks](security.md). STARTTLS is not offered over WebSockets, which use `wss` for TLS, as in [Hosting in a web server](web-servers.md).

## How certificates are checked

Node certificates mark each level of their chain with a critical extension that OpenSSL does not recognize, so the TLS module of Node.js rejects all of them. The package turns its check off and checks the chain itself before anything else is sent: signatures, dates, certificate authority flags and path lengths, the Robot Raconteur extension for each level, and the node named in the certificate. {@link verifyNodeCertificate} performs the same check on its own.
