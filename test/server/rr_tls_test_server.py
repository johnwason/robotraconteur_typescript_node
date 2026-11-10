#!/usr/bin/env python3
"""A Core TLS server for testing rrs+tcp. Prints PORT n when ready, and runs until stdin closes.

Usage: rr_tls_test_server.py <node id> <config dir> [--ca <pem file>]

The node certificate must be <config dir>/certificates/{<node id>}.p12, where Core looks for it. A
certificate authority given with --ca is trusted for client certificates, in addition to the
Robot Raconteur roots built into Core.
"""
import os
import sys

node_id, config_dir = sys.argv[1], sys.argv[2]
# Core finds the node certificate in its config directory, which is the system one when run as root
os.environ["ROBOTRACONTEUR_USER_CONFIG_DIR"] = config_dir
os.environ["ROBOTRACONTEUR_SYSTEM_CONFIG_DIR"] = config_dir
if "--ca" in sys.argv:
    os.environ["ROBOTRACONTEUR_SSL_CERT_FILE"] = sys.argv[sys.argv.index("--ca") + 1]

import RobotRaconteur as RR  # noqa: E402

SERVICE_DEF = """service experimental.tls_test

object testobj
    function double add_two_numbers(double a, double b)
end object
"""


class TestObj:
    def add_two_numbers(self, a, b):
        return a + b


node = RR.RobotRaconteurNode()
node.SetNodeID(RR.NodeID(node_id))
node.Init()
with RR.SecureServerNodeSetup("", 0, node=node) as setup:
    if not setup.tcp_transport.IsTlsNodeCertificateLoaded:
        print("Could not load the node certificate", file=sys.stderr)
        sys.exit(1)
    node.RegisterServiceType(SERVICE_DEF)
    node.RegisterService("test_service", "experimental.tls_test.testobj", TestObj())
    print(f"PORT {setup.tcp_transport.GetListenPort()}", flush=True)
    sys.stdin.read()
