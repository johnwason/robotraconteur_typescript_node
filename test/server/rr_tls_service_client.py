#!/usr/bin/env python3
"""Use a TypeScript service over rrs+tcp from Core's Python client. Prints the identity the service
verified for this client, then OK.

Usage: rr_tls_service_client.py <url> <certificate authority> [<config dir> <node id>]

The certificate authority is trusted with ROBOTRACONTEUR_SSL_CERT_FILE. With a config dir and node
ID, the client loads its node certificate from <config dir>/certificates/{<node id>}.p12 and asks
the service to check it.
"""

import os
import sys

url, ca = sys.argv[1], sys.argv[2]
os.environ["ROBOTRACONTEUR_SSL_CERT_FILE"] = ca
if len(sys.argv) > 4:
    os.environ["ROBOTRACONTEUR_USER_CONFIG_DIR"] = sys.argv[3]
    os.environ["ROBOTRACONTEUR_SYSTEM_CONFIG_DIR"] = sys.argv[3]

import RobotRaconteur as RR  # noqa: E402 pylint: disable=wrong-import-position

RRN = RR.RobotRaconteurNode.s


def main():
    if len(sys.argv) > 4:
        RRN.SetNodeID(RR.NodeID(sys.argv[4]))
    tcp = RR.TcpTransport()
    if len(sys.argv) > 4:
        tcp.LoadTlsNodeCertificate()
    RRN.RegisterTransport(tcp)
    try:
        c = RRN.ConnectService(url)
        assert c.add(2, 3) == 5
        print("IDENTITY " + c.peer_identity(), flush=True)
        RRN.DisconnectService(c)
        print("OK", flush=True)
    finally:
        RRN.Shutdown()


if __name__ == "__main__":
    main()
