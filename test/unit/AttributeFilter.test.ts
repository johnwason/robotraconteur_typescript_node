// Copyright 2011-2026 Wason Technology, LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import assert from "node:assert/strict";
import test from "node:test";
import { NodeID, VarValue } from "robotraconteur";
import {
    createServiceSubscriptionFilterAttributeCombinedIdentifier,
    createServiceSubscriptionFilterAttributeIdentifier as identifier,
    createServiceSubscriptionFilterAttributeRegex as regex,
    ServiceSubscriptionFilterAttribute as Attribute,
    ServiceSubscriptionFilterAttributeGroup as Group
} from "../../src/index.js";
import type { ServiceSubscriptionFilter } from "../../src/index.js";
import { filterService } from "../../src/discovery/Subscriptions.js";
import type { NodeStorage, ServiceInfo2 } from "../../src/discovery/NodeDiscovery.js";

const UUID = "cbfea7a4-0361-4aad-95bb-d4dcd967047a";
const TYPE = "com.robotraconteur.testing.subtestfilter.sub_testroot";

// From CreateIdentifierAttributeFilterTest in Core's test/cpp/misc/misc_tests.cpp
test("identifier attributes match as in Core", () =>
{
    const attr1 = identifier("identifier_1", "");
    assert.equal(attr1.isMatch("identifier_1"), true);
    assert.equal(attr1.isMatch("identifier_2"), false);
    assert.equal(attr1.isMatch(`identifier_1|${UUID}`), true);
    assert.equal(attr1.isMatch(`identifier_2|${UUID}`), false);

    const attr2 = identifier("", UUID);
    assert.equal(attr2.isMatch("identifier_1"), false);
    assert.equal(attr2.isMatch("identifier_2"), false);
    assert.equal(attr2.isMatch(`identifier_1|${UUID}`), true);
    assert.equal(attr2.isMatch("identifier_2|{cbfea7a4-0361-4aAD-95bb-d4dcd967047a}"), true);
    assert.equal(attr2.isMatch("identifier_2|cbfea7a403614aAD95bbd4dcd967047a"), true);
    assert.equal(attr2.isMatch("identifier_2|{cbfea7a4-0361-1aad-95bb-d4dcd967047a}"), false);

    const attr3 = identifier("identifier_1", "{00000000-0000-0000-0000-000000000000}");
    assert.equal(attr3.isMatch("identifier_1"), true);
    assert.equal(attr3.isMatch("identifier_2"), false);
    assert.equal(attr3.isMatch(`identifier_1|${UUID}`), true);
    assert.equal(attr3.isMatch(`identifier_2|${UUID}`), false);

    const attr4 = identifier("identifier_1", UUID);
    assert.equal(attr4.isMatch("identifier_1"), false);
    assert.equal(attr4.isMatch("identifier_2"), false);
    assert.equal(attr4.isMatch(`identifier_1|${UUID}`), true);
    assert.equal(attr4.isMatch(`identifier_2|${UUID}`), false);

    const attr5 = identifier("identifier_1.with.do_ts", UUID);
    assert.equal(attr5.isMatch("identifier_1.with.do_ts"), false);
    assert.equal(attr5.isMatch("identifier_2.WIT_H.dot4s"), false);
    assert.equal(attr5.isMatch("identifier_1"), false);
    assert.equal(attr5.isMatch("identifier_2"), false);
    assert.equal(attr5.isMatch(`identifier_1.with.do_ts|${UUID}`), true);
    assert.equal(attr5.isMatch("identifier_1.with.do_ts|{cbfea7a4-0361-4AAD95bb-d4dcd967047a}"), true);
    assert.equal(attr5.isMatch(`identifier_2.WIT_H.dot4s|${UUID}`), false);
    assert.equal(attr5.isMatch("identifier_1.with.do_ts|cbfea7a4-0361-41ad-95bb-d4dcd967047a"), false);
});

test("identifiers are validated and can name a map entry", () =>
{
    assert.throws(() => identifier("", ""), RangeError);
    assert.throws(() => identifier("1bad", ""), RangeError);
    assert.throws(() => identifier("name", "not-a-uuid"), RangeError);
    assert.throws(() => identifier("", "00000000-0000-0000-0000-000000000000"), RangeError);

    const a = identifier("key", "identifier_1", UUID);
    assert.equal(a.isMatch("key", `identifier_1|${UUID}`), true);
    assert.equal(a.isMatch("other", `identifier_1|${UUID}`), false);
    assert.equal(a.isMatch(`identifier_1|${UUID}`), false);
});

test("combined identifiers accept a name, a UUID, or both", () =>
{
    const combined = createServiceSubscriptionFilterAttributeCombinedIdentifier;
    assert.equal(combined("identifier_1").isMatch(`identifier_1|${UUID}`), true);
    assert.equal(combined("identifier_1").isMatch("identifier_2"), false);
    assert.equal(combined(UUID).isMatch(`any_name|${UUID}`), true);
    assert.equal(combined(UUID).isMatch("any_name"), false);
    assert.equal(combined(`identifier_1|${UUID}`).isMatch(`identifier_1|${UUID}`), true);
    assert.equal(combined(`identifier_1|${UUID}`).isMatch(`identifier_2|${UUID}`), false);
    assert.equal(combined(`identifier_1|${UUID}`).isMatch("identifier_1"), false);
});

test("attributes match a value, a named value, a list, or a map", () =>
{
    const plain = new Attribute("v1");
    const named = new Attribute("k1", "v1");
    assert.equal(plain.isMatch("v1"), true);
    assert.equal(plain.isMatch("v2"), false);
    assert.equal(named.isMatch("v1"), false, "a named attribute needs a name to match");
    assert.equal(named.isMatch("k1", "v1"), true);
    assert.equal(named.isMatch("k2", "v1"), false);
    assert.equal(plain.isMatch("any_key", "v1"), true);

    assert.equal(plain.isMatch(["v2", "v1"]), true);
    assert.equal(plain.isMatch(["v2"]), false);
    assert.equal(plain.isMatch([new VarValue("v1", "string"), null, new VarValue(Int32Array.of(1), "int32[]")]), true);

    const map = new Map<string, unknown>([["k1", new VarValue("v1", "string")], ["k2", new VarValue(Int32Array.of(1), "int32[]")], ["k3", null]]);
    assert.equal(named.isMatch(map), true);
    assert.equal(new Attribute("k2", "v1").isMatch(map), false);
    assert.equal(plain.isMatch(map), true);
});

test("a regular expression must match the entire value", () =>
{
    const a = regex("attr");
    assert.equal(a.isMatch("attr"), true);
    assert.equal(a.isMatch("test_attr_val"), false);
    assert.equal(regex(".*_val1").isMatch("test_attr_val1"), true);
    assert.equal(regex(/a|b/).isMatch("a"), true);
    assert.equal(regex(/a|b/).isMatch("ab"), false);
    assert.equal(regex(/ATTR/i).isMatch("attr"), true);
    assert.equal(regex("k1", "v.").isMatch("k1", "v1"), true);
    assert.equal(regex("k1", "v.").isMatch("k2", "v1"), false);

    const repeated = regex(/v/g);
    assert.equal(repeated.isMatch("v"), true);
    assert.equal(repeated.isMatch("v"), true, "matching must not keep state between calls");
});

test("groups combine attributes and nested groups", () =>
{
    const a = new Attribute("a");
    const b = new Attribute("b");
    const values = ["a", "c"];

    assert.equal(new Group("or", [a, b]).isMatch(values), true);
    assert.equal(new Group("and", [a, b]).isMatch(values), false);
    assert.equal(new Group("nor", [a, b]).isMatch(values), false);
    assert.equal(new Group("nand", [a, b]).isMatch(values), true);
    assert.equal(new Group("nor", [b]).isMatch(values), true);
    assert.equal(new Group("nand", [a]).isMatch(values), false);

    assert.equal(new Group().isMatch(values), true);
    assert.equal(new Group("and").isMatch(values), true);
    assert.equal(new Group("nor").isMatch(values), false);
    assert.equal(new Group("nand").isMatch(values), false);

    const nested = new Group("and", [new Group("or", [a, b]), new Group("nor", [b]), new Attribute("c")]);
    assert.equal(nested.isMatch(values), true);
    assert.equal(nested.isMatch(["a", "b", "c"]), false);
});

test("groups handle each kind of attribute value", () =>
{
    const a = new Attribute("a");
    const group = new Group("or", [a]);
    assert.equal(group.isMatch("a"), true);
    assert.equal(group.isMatch("x,a,y"), true);
    assert.equal(group.isMatch(new VarValue("x,a", "string")), true);
    assert.equal(group.isMatch(null), false);
    assert.equal(new Group("nor", [a]).isMatch(null), true);
    assert.equal(new Group().isMatch(undefined), true);
    assert.equal(group.isMatch(new VarValue(Int32Array.of(1), "int32[]")), false);
    assert.equal(new Group("nor", [a]).isMatch(new VarValue(Int32Array.of(1), "int32[]")), false, "other types never match");
    assert.equal(group.isMatch(new VarValue([new VarValue("a", "string")], "varvalue{list}")), true);
    assert.equal(group.isMatch(new VarValue(new Map([["k", new VarValue("a", "string")]]), "varvalue{string}")), true);

    const whole = new Group("or", [a]);
    whole.splitStringAttribute = false;
    assert.equal(whole.isMatch("x,a"), false);
    assert.equal(whole.isMatch("a"), true);

    const semicolons = new Group("or", [a]);
    semicolons.splitStringDelimiter = ";";
    assert.equal(semicolons.isMatch("x;a"), true);
    assert.equal(semicolons.isMatch("x,a"), false);
});

function service(name: string, node_name: string, attributes: Record<string, string>, type = TYPE): ServiceInfo2
{
    return {
        name,
        rootObjectType: type,
        rootObjectImplements: [],
        connectionURLs: [`rr+tcp://[fe80::1]:1/?service=${name}`],
        attributes: new Map(Object.entries(attributes).map(([k, v]) => [k, new VarValue(v, "string")])),
        nodeID: NodeID.newUniqueID(),
        nodeName: node_name
    };
}

const NO_STORAGE = { info: { urls: [] } } as unknown as NodeStorage;

// The same services and expected counts as test_subscriber_attribute_filter in Core's Python tests
const SERVICES = [
    service("service1", "test_node1", { a1: "test_attr_val1", a2: "test_attr_val2", a4: "test_attr_val4,test_attr_val4_1" }),
    service("service2", "test_node2", { a2: "test_attr_val2", a3: "test_attr_val3,test_attr_val3_1" }),
    service("service3", "test_node7", { a1: "test_attr_val3", a2: "test_attr_val5", a4: "test_attr_val4,test_attr_val4_2" })
];
const count = (filter?: ServiceSubscriptionFilter) => SERVICES.filter((s) => filterService([TYPE], filter, NO_STORAGE, s)).length;

test("attribute filters select the same services as Core", () =>
{
    assert.equal(count(), 3);
    assert.equal(count({ attributes: { a1: new Group("or", [new Attribute("test_attr_val1")]) } }), 1);
    assert.equal(count({ attributes: { a4: new Group("or", [new Attribute("test_attr_val4"), new Attribute("test_attr_val4_2")]) } }), 2);
    assert.equal(count({ attributes: { a4: new Group("and", [new Attribute("test_attr_val4"), new Attribute("test_attr_val4_2")]) } }), 1);
    assert.equal(count({ attributes: { a1: new Group("or", [regex(".*_attr_val1")]) } }), 1);
    assert.equal(count({
        attributes: { a1: new Group("or", [regex(".*_attr_val1")]), a4: new Group("or", [new Attribute("test_attr_val_not_there")]) },
        attributesMatchOperation: "or"
    }), 1);
});

test("attribute groups combine with the filter's operation", () =>
{
    const a1 = new Group("or", [new Attribute("test_attr_val1")]);
    const a2 = new Group("or", [new Attribute("test_attr_val2")]);
    assert.equal(count({ attributes: { a1, a2 } }), 1);
    assert.equal(count({ attributes: { a1, a2 }, attributesMatchOperation: "or" }), 2);
    assert.equal(count({ attributes: { a1, a2 }, attributesMatchOperation: "nor" }), 1);
    assert.equal(count({ attributes: { a1, a2 }, attributesMatchOperation: "nand" }), 2);
    assert.equal(count({ attributes: new Map([["a1", a1]]) }), 1);
    assert.equal(count({ attributes: {} }), 3);
});

// From test_subscriber_filter in Core's Python tests
test("node and service name filters select the same services as Core", () =>
{
    const type2 = TYPE + "2";
    const list = [
        service("service1", "test_node3", {}, type2),
        service("service1", "test_node4", {}, type2),
        service("service3", "test_node5", {}, type2),
        service("service2", "test_node6", {}, type2),
        service("service1", "test_node5", {}, type2)
    ];
    const matching = (filter?: ServiceSubscriptionFilter) => list.flatMap((s) =>
    {
        const m = filterService([type2], filter, NO_STORAGE, s);
        return m ? [m] : [];
    });

    assert.equal(matching().length, 5);
    assert.equal(matching({ serviceNames: ["service1"] }).length, 3);
    assert.equal(matching({ serviceNames: ["service1"], nodes: [{ nodeName: "test_node3" }] }).length, 1);

    const credentials = { password: new VarValue("testpass1", "string") };
    const found = matching({ serviceNames: ["service1"], nodes: [{ nodeName: "test_node5", username: "testuser1", credentials }] });
    assert.equal(found.length, 1);
    assert.equal(found[0]!.node?.username, "testuser1");
    assert.equal(found[0]!.node?.credentials, credentials);
});
