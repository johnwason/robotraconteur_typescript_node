#!/usr/bin/env python3
"""Use the TypeScript test service in TestService.ts from Core's Python client. Prints OK if every
check passes.

Usage: rr_service_test_client.py <url>
"""

import sys
import threading

import numpy as np
import RobotRaconteur as RR

RRN = RR.RobotRaconteurNode.s


def main():
    url = sys.argv[1]
    RRN.SetLogLevelFromEnvVariable()
    tcp = RR.TcpTransport()
    RRN.RegisterTransport(tcp)
    try:
        c = RRN.ConnectService(url)

        # Service definition, attributes, and the documentation the definition carries
        assert RRN.GetServiceAttributes(c)["Location"].data == "lab"
        d = RRN.GetPulledServiceType(c, "experimental.ts_service_test")
        assert d.Name == "experimental.ts_service_test"

        # Properties
        c.d1 = 3.5
        assert c.d1 == 3.5
        c.ia = np.array([7, 8, 9], dtype=np.int32)
        assert list(c.ia) == [7, 8, 9]
        p = RRN.NewStructure("experimental.ts_service_test.point", c)
        p.x = 1.25
        p.y = -2.0
        c.p1 = p
        assert c.p1.x == 1.25 and c.p1.y == -2.0
        c.m1 = 5
        assert c.m1 == 5
        c.v1 = RR.VarValue("from python", "string")
        assert c.v1.data == "from python"
        c.smap = {"py": "thon"}
        assert c.smap == {"py": "thon"}
        try:
            c.s1 = "x"
            raise AssertionError("readonly property was written")
        except RR.ReadOnlyMemberException:
            pass

        # Functions
        assert c.add(2.0, 3.0) == 5.0
        assert c.add_slowly(1.0, 2.0) == 3.0
        c.set_s1("from python")
        assert c.s1 == "from python"
        pt = c.make_point(4.0, 5.0)
        assert pt.x == 4.0 and pt.y == 5.0
        try:
            c.fail_rr("bad value")
            raise AssertionError("no error")
        except RR.InvalidArgumentException as e:
            assert e.message == "bad value"
            assert e.errorsubname == "test.sub"
            assert list(e.errorparam.data) == [4.0, 5.0]
        try:
            c.fail_plain("oops")
            raise AssertionError("no error")
        except RR.RobotRaconteurException as e:
            assert e.errorname == "TypeError"

        # Events
        got = threading.Event()
        received = []

        def on_ev1(message, value):
            received.append((message, value))
            got.set()
        c.ev1 += on_ev1
        c.fire_event("from python", 6.5)
        assert got.wait(10)
        assert received == [("from python", 6.5)]

        # Objrefs
        o1 = c.get_o1()
        assert o1.name.startswith("o1")
        assert o1.path() == "test.o1"
        assert o1.get_child().name == o1.name + ".child"
        assert c.get_o2(7).name == "o2 7"
        assert c.get_o3("x.y").name == "o3 x.y"
        assert c.get_o4().name == "o4"

        RRN.DisconnectService(c)
        print("OK", flush=True)
    finally:
        RRN.Shutdown()


if __name__ == "__main__":
    main()
