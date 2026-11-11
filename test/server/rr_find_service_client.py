#!/usr/bin/env python3
"""Find a service by type with Core's discovery and use it. Prints OK if the service of the
given node is found and works.

Usage: rr_find_service_client.py <service type> <node id>
"""

import sys
import time

from RobotRaconteur.Client import *  # noqa: F401,F403 pylint: disable=wildcard-import,unused-wildcard-import


def main():
    service_type, nodeid = sys.argv[1], sys.argv[2]
    found = []
    for _ in range(30):
        found = [s for s in RRN.FindServiceByType(service_type, ["rr+tcp"]) if str(s.NodeID) == nodeid]
        if found:
            break
        time.sleep(0.5)
    assert found, "service not found"
    s = found[0]
    assert s.RootObjectType == service_type
    assert s.Attributes["Location"].data == "lab"
    c = RRN.ConnectService(s.ConnectionURL)
    assert c.add(2.0, 3.0) == 5.0
    RRN.DisconnectService(c)
    print("OK", flush=True)


if __name__ == "__main__":
    main()
