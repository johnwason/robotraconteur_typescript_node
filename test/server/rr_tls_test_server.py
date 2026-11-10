#!/usr/bin/env python3
"""A Core TLS server for testing rrs+tcp. Prints PORT n when ready, and runs until stdin closes.

Usage: rr_tls_test_server.py <node id> <config dir> [--ca <pem file>]

The node certificate must be <config dir>/certificates/{<node id>}.p12, where Core looks for it. A
certificate authority given with --ca is trusted for client certificates, in addition to the
Robot Raconteur roots built into Core.

On Windows, Core usually uses Schannel, which reads the node certificate from the certificate store
of the current user instead. If RR_TEST_WINDOWS_CERT_STORE is set, the certificate is added to that
store, and the certificate authority to the trusted roots of the machine, and both are removed when
the server stops. This changes what the machine trusts, so it is meant for CI only.
"""
import os
import subprocess
import sys

node_id, config_dir = sys.argv[1], sys.argv[2]
# Core finds the node certificate in its config directory, which is the system one when run as root
os.environ["ROBOTRACONTEUR_USER_CONFIG_DIR"] = config_dir
os.environ["ROBOTRACONTEUR_SYSTEM_CONFIG_DIR"] = config_dir
if "--ca" in sys.argv:
    os.environ["ROBOTRACONTEUR_SSL_CERT_FILE"] = sys.argv[sys.argv.index("--ca") + 1]

import RobotRaconteur as RR  # noqa: E402


def powershell(command):
    r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
                       capture_output=True, text=True, check=True)
    return [x.strip() for x in r.stdout.splitlines() if x.strip()]


def add_to_windows_stores(p12, ca):
    """Add certificates to the Windows stores, returning the store paths to remove afterwards"""
    added = []
    existing = set(powershell("Get-ChildItem Cert:\\CurrentUser\\My | ForEach-Object { $_.Thumbprint }"))
    for t in powershell(f"Import-PfxCertificate -FilePath '{p12}' -CertStoreLocation Cert:\\CurrentUser\\My "
                        "-Password (New-Object System.Security.SecureString) | ForEach-Object { $_.Thumbprint }"):
        if t not in existing:
            added.append("Cert:\\CurrentUser\\My\\" + t)
    if ca:
        existing = set(powershell("Get-ChildItem Cert:\\LocalMachine\\Root | ForEach-Object { $_.Thumbprint }"))
        for t in powershell(f"Import-Certificate -FilePath '{ca}' -CertStoreLocation Cert:\\LocalMachine\\Root "
                            "| ForEach-Object { $_.Thumbprint }"):
            if t not in existing:
                added.append("Cert:\\LocalMachine\\Root\\" + t)
    return added


def remove_from_windows_stores(paths):
    for p in paths:
        try:
            powershell(f"Remove-Item '{p}' -DeleteKey -ErrorAction SilentlyContinue; "
                       f"Remove-Item '{p}' -ErrorAction SilentlyContinue")
        except subprocess.CalledProcessError:
            pass

SERVICE_DEF = """service experimental.tls_test

object testobj
    function double add_two_numbers(double a, double b)
end object
"""


class TestObj:
    def add_two_numbers(self, a, b):
        return a + b


added = []
if os.name == "nt" and os.environ.get("RR_TEST_WINDOWS_CERT_STORE"):
    ca = sys.argv[sys.argv.index("--ca") + 1] if "--ca" in sys.argv else None
    added = add_to_windows_stores(os.path.join(config_dir, "certificates", node_id + ".p12"), ca)

try:
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
finally:
    remove_from_windows_stores(added)
