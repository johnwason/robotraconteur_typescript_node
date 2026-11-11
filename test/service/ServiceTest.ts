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

/* eslint-disable @typescript-eslint/no-explicit-any */

// Port of Core's Python test service, test/python/RobotRaconteurTest/ServiceTest.py, in the same
// order. Values come from Core's test vector blob, as in Core. Pipes, wires, callbacks, and
// memories are not ported yet, because robotraconteur-node services do not support them yet.

import assert from "node:assert/strict";
import { RobotRaconteurError, VarValue } from "robotraconteur";
import { MessageErrorType } from "robotraconteur/internal";
import { getTestVector } from "@shared/test/common/TestVectors.js";
import { ca, cae, md } from "@shared/test/common/TestUtil.js";
import { EventHook } from "../../src/index.js";
import type { ServerContext } from "../../src/index.js";

const T1 = "com.robotraconteur.testing.TestService1";
const T2 = "com.robotraconteur.testing.TestService2";

/** The array of a vector and its dimensions, as numpy.array(...).reshape(dims, order="F") */
function mdv(name: string, type = "double"): any
{
    return md(getTestVector(name, type), getTestVector(name + ".dims", "uint32"));
}

function teststruct2(mydat: unknown): any
{
    return { mydat };
}

function error(code: MessageErrorType, name: string, message: string): RobotRaconteurError
{
    return new RobotRaconteurError(code, name, message);
}

export class testroot_impl
{
    private _o1 = new sub1_impl();
    private _o2 = new Map<number, sub1_impl>();
    private _o3 = new Map<number, sub1_impl>();
    private _o4 = new Map<string, sub1_impl>();
    private _o5 = new sub1_impl();
    private _o6: sub1_impl | sub2_impl | subobj_impl = new sub1_impl();

    ev1 = new EventHook<[]>();
    ev2 = new EventHook<[number, unknown]>();

    private context: ServerContext | null = null;
    private service_path = "";

    RRServiceObjectInit(context: ServerContext, service_path: string): void
    {
        this.context = context;
        this.service_path = service_path;
    }

    get d1(): number
    {
        return 12.345;
    }

    set d1(value: number)
    {
        assert.equal(value, 3.456);
    }

    get d2(): any
    {
        return getTestVector("ts1.d2.to_client", "double");
    }

    set d2(value: any)
    {
        ca(value, getTestVector("ts1.d2.to_service", "double"));
    }

    get d3(): any
    {
        return getTestVector("ts1.d3.to_client", "double");
    }

    set d3(value: any)
    {
        ca(value, getTestVector("ts1.d3.to_service", "double"));
    }

    get d4(): any
    {
        return getTestVector("ts1.d4.to_client", "double");
    }

    set d4(value: any)
    {
        ca(value, getTestVector("ts1.d4.to_service", "double"));
    }

    get d5(): any
    {
        return mdv("ts1.d5.to_client");
    }

    set d5(value: any)
    {
        ca(value, mdv("ts1.d5.to_service"));
    }

    get d6(): any
    {
        return mdv("ts1.d6.to_client");
    }

    set d6(value: any)
    {
        ca(value, mdv("ts1.d6.to_service"));
    }

    get s1(): number
    {
        return 7.8573;
    }

    set s1(_value: number)
    {
        // Not checked, as in Core
    }

    get s2(): any
    {
        return getTestVector("ts1.s2.to_client", "single");
    }

    set s2(_value: any)
    {
        // Not checked, as in Core
    }

    get i8_1(): number
    {
        return -66;
    }

    set i8_1(value: number)
    {
        assert.equal(value, 45);
    }

    get i8_2(): any
    {
        return getTestVector("ts1.i8_2.to_client", "int8");
    }

    set i8_2(value: any)
    {
        cae(value, getTestVector("ts1.i8_2.to_service", "int8"));
    }

    get u8_1(): number
    {
        return 222;
    }

    set u8_1(value: number)
    {
        assert.equal(value, 232);
    }

    get u8_2(): any
    {
        return getTestVector("ts1.u8_2.to_client", "uint8");
    }

    set u8_2(value: any)
    {
        cae(value, getTestVector("ts1.u8_2.to_service", "uint8"));
    }

    get u8_3(): any
    {
        return mdv("ts1.u8_3.to_client", "uint8");
    }

    set u8_3(value: any)
    {
        cae(value, mdv("ts1.u8_3.to_service", "uint8"));
    }

    get i16_1(): number
    {
        return -13428;
    }

    set i16_1(value: number)
    {
        assert.equal(value, 2387);
    }

    get i16_2(): any
    {
        return getTestVector("ts1.i16_2.to_client", "int16");
    }

    set i16_2(value: any)
    {
        cae(value, getTestVector("ts1.i16_2.to_service", "int16"));
    }

    get u16_1(): number
    {
        return 60981;
    }

    set u16_1(value: number)
    {
        assert.equal(value, 54732);
    }

    get u16_2(): any
    {
        return getTestVector("ts1.u16_2.to_client", "uint16");
    }

    set u16_2(value: any)
    {
        cae(value, getTestVector("ts1.u16_2.to_service", "uint16"));
    }

    get i32_1(): number
    {
        return 898734;
    }

    set i32_1(value: number)
    {
        assert.equal(value, -9837284);
    }

    get i32_2(): any
    {
        return getTestVector("ts1.i32_2.to_client", "int32");
    }

    set i32_2(value: any)
    {
        cae(value, getTestVector("ts1.i32_2.to_service", "int32"));
    }

    get i32_huge(): Int32Array
    {
        const o = new Int32Array(2621440);
        for (let i = 0; i < o.length; i++) o[i] = i;
        return o;
    }

    set i32_huge(value: Int32Array)
    {
        assert.equal(value.length, 2621440);
        for (let i = 0; i < value.length; i++) assert.ok(value[i] === -i);
    }

    get u32_1(): number
    {
        return 547919123;
    }

    set u32_1(value: number)
    {
        assert.equal(value, 1550099195);
    }

    get u32_2(): any
    {
        return getTestVector("ts1.u32_2.to_client", "uint32");
    }

    set u32_2(value: any)
    {
        cae(value, getTestVector("ts1.u32_2.to_service", "uint32"));
    }

    get i64_1(): bigint
    {
        return -1357833931563696072n;
    }

    set i64_1(value: bigint)
    {
        assert.equal(value, 8621740821050813024n);
    }

    get i64_2(): any
    {
        return getTestVector("ts1.i64_2.to_client", "int64");
    }

    set i64_2(value: any)
    {
        cae(value, getTestVector("ts1.i64_2.to_service", "int64"));
    }

    get u64_1(): bigint
    {
        return 13389861970863644378n;
    }

    set u64_1(value: bigint)
    {
        assert.equal(value, 1465640522145789825n);
    }

    get u64_2(): any
    {
        return getTestVector("ts1.u64_2.to_client", "uint64");
    }

    set u64_2(value: any)
    {
        cae(value, getTestVector("ts1.u64_2.to_service", "uint64"));
    }

    get str1(): string
    {
        return "Hello Client!";
    }

    set str1(value: string)
    {
        assert.equal(value, "Hello Server!");
    }

    get struct1(): any
    {
        const s1_dstruct2_1 = teststruct2(getTestVector("ts1.struct1.dstruct2_1.to_client", "double"));
        const s1_dstruct2_2 = teststruct2(getTestVector("ts1.struct1.dstruct2_3.to_client", "double"));
        return {
            dat1: getTestVector("ts1.struct1.dat1.to_client", "double"),
            str2: "Hello world!",
            vec3: new Map([[1, "Hello Client!"], [2, "Hello Client, again"], [4372, "This is yet another test string"]]),
            dict4: new Map([["teststring1", "Hello Client!"], ["teststring2", "Hello Client, again"], ["anotherstr", "This is yet another test string"]]),
            list5: ["Hello Client!", "Hello Client, again", "This is yet another test string"],
            struct1: teststruct2(getTestVector("ts1.struct1.struct1_mydat.to_client", "double")),
            dstruct2: new Map([["test1", s1_dstruct2_1], ["anothertest", s1_dstruct2_2]]),
            // Core sends the dstruct2 values here too
            lstruct3: [s1_dstruct2_1, s1_dstruct2_2],
            multidimarray: mdv("ts1.struct1.multidimarray.to_client"),
            var3: new VarValue("This is a vartype string", "string")
        };
    }

    set struct1(value: any)
    {
        ca(value.dat1, getTestVector("ts1.struct1.dat1.to_service", "double"));
        assert.equal(value.str2, "Hello world 2!");
        assert.equal(value.vec3.size, 4);
        assert.equal(value.vec3.get(10), "Hello Server!");
        assert.equal(value.vec3.get(11), "Hello Server, again");
        assert.equal(value.vec3.get(46372), "Test string!");
        assert.equal(value.vec3.get(46373), "Test string again");
        assert.equal(value.dict4.size, 2);
        assert.equal(value.dict4.get("cteststring1"), "Hello Server!");
        assert.equal(value.dict4.get("cteststring2"), "Hello Server, again");
        ca(value.struct1.mydat, getTestVector("ts1.struct1.struct1_mydat.to_service", "double"));
        assert.equal(value.dstruct2.size, 2);
        ca(value.dstruct2.get("ctest1").mydat, getTestVector("ts1.struct1.dstruct2_1.to_service", "double"));
        ca(value.dstruct2.get("anothertest").mydat, getTestVector("ts1.struct1.dstruct2_2.to_service", "double"));
        assert.equal(value.lstruct3.length, 2);
        ca(value.lstruct3[0].mydat, getTestVector("ts1.struct1.dstruct2_1.to_service", "double"));
        ca(value.lstruct3[1].mydat, getTestVector("ts1.struct1.dstruct2_2.to_service", "double"));
        ca(value.multidimarray, mdv("ts1.struct1.multidimarray.to_service"));
        ca(value.var3.value, getTestVector("ts1.struct1.var3.to_service", "double"));
    }

    get struct2(): any
    {
        return teststruct2(getTestVector("ts1.struct2.to_client", "double"));
    }

    set struct2(value: any)
    {
        ca(value.mydat, getTestVector("ts1.struct2.to_service", "double"));
    }

    get struct3(): any
    {
        return { a1: getTestVector("ts1.struct3.to_client", "double") };
    }

    set struct3(value: any)
    {
        ca(value.a1, getTestVector("ts1.struct3.to_service", "double"));
    }

    get is_d1(): Map<number, number>
    {
        return new Map([[9285, 1.643392e-01], [74822, 1.537133e+09], [4, 1.369505e-03]]);
    }

    set is_d1(value: Map<number, number>)
    {
        assert.equal(value.size, 3);
        assert.equal(value.get(928), 4.074501e-07);
        assert.equal(value.get(394820), -4.535303e+05);
        assert.equal(value.get(623), -2.956241e-20);
    }

    get is_d2(): Map<string, number>
    {
        return new Map([["testval1", -1.079664e+16], ["testval2", 2.224846e+00]]);
    }

    set is_d2(value: Map<string, number>)
    {
        assert.equal(value.size, 2);
        assert.equal(value.get("testval3"), 5.242474e+10);
        assert.equal(value.get("testval4"), 2.208636e+08);
    }

    get is_d3(): Map<number, any>
    {
        return new Map([[12, getTestVector("ts1.is_d3.to_client.a", "double")], [832, getTestVector("ts1.is_d3.to_client.b", "double")]]);
    }

    set is_d3(value: Map<number, any>)
    {
        assert.equal(value.size, 2);
        ca(value.get(47), getTestVector("ts1.is_d3.to_service.a", "double"));
        ca(value.get(324), getTestVector("ts1.is_d3.to_service.b", "double"));
    }

    get is_d4(): Map<string, any>
    {
        return new Map([["testval1", getTestVector("ts1.is_d4.to_client.a", "double")], ["testval2", getTestVector("ts1.is_d4.to_client.b", "double")]]);
    }

    set is_d4(value: Map<string, any>)
    {
        assert.equal(value.size, 2);
        ca(value.get("testval3"), getTestVector("ts1.is_d4.to_service.a", "double"));
        ca(value.get("testval4"), getTestVector("ts1.is_d4.to_service.b", "double"));
    }

    get is_d5(): Map<number, any>
    {
        return new Map([[564, mdv("ts1.is_d5.to_client")]]);
    }

    set is_d5(value: Map<number, any>)
    {
        assert.equal(value.size, 1);
        ca(value.get(328), mdv("ts1.is_d5.to_service"));
    }

    get is_d6(): Map<string, any>
    {
        return new Map([["testval1", mdv("ts1.is_d6.to_client")]]);
    }

    set is_d6(value: Map<string, any>)
    {
        // Core returns without checking if the size is wrong
        if (value.size !== 1) return;
        ca(value.get("testval2"), mdv("ts1.is_d6.to_service"));
    }

    get is_str1(): Map<number, string>
    {
        return new Map([[23, "Hello server"]]);
    }

    set is_str1(value: Map<number, string>)
    {
        assert.equal(value.size, 1);
        assert.equal(value.get(24), "Hello client");
    }

    get is_str2(): Map<string, string>
    {
        return new Map([["testval1", "Hello server"]]);
    }

    set is_str2(value: Map<string, string>)
    {
        assert.equal(value.size, 1);
        assert.equal(value.get("testval2"), "Hello client");
    }

    get is_struct1(): Map<number, any>
    {
        return new Map([[748, teststruct2(getTestVector("ts1.is_struct1.to_client", "double"))]]);
    }

    set is_struct1(value: Map<number, any>)
    {
        assert.equal(value.size, 1);
        ca(value.get(372).mydat, getTestVector("ts1.is_struct1.to_service", "double"));
    }

    get is_struct2(): Map<string, any>
    {
        return new Map([["testval1", teststruct2(getTestVector("ts1.is_struct2.to_client", "double"))]]);
    }

    set is_struct2(value: Map<string, any>)
    {
        assert.equal(value.size, 1);
        ca(value.get("testval2").mydat, getTestVector("ts1.is_struct2.to_service", "double"));
    }

    get list_d1(): number[]
    {
        return [1.643392e-01, 1.537133e+09, 1.369505e-03];
    }

    set list_d1(value: number[])
    {
        assert.equal(value.length, 3);
        assert.equal(value[0], 4.074501e-07);
        assert.equal(value[1], -4.535303e+05);
        assert.equal(value[2], -2.956241e-20);
    }

    get list_d3(): any[]
    {
        return [getTestVector("ts1.is_d3.to_client.a", "double"), getTestVector("ts1.is_d3.to_client.b", "double")];
    }

    set list_d3(value: any[])
    {
        assert.equal(value.length, 2);
        ca(value[0], getTestVector("ts1.is_d3.to_service.a", "double"));
        ca(value[1], getTestVector("ts1.is_d3.to_service.b", "double"));
    }

    get list_d5(): any[]
    {
        return [mdv("ts1.is_d5.to_client")];
    }

    set list_d5(value: any[])
    {
        assert.equal(value.length, 1);
        ca(value[0], mdv("ts1.is_d5.to_service"));
    }

    get list_str1(): string[]
    {
        return ["Hello server"];
    }

    set list_str1(value: string[])
    {
        assert.equal(value.length, 1);
        assert.equal(value[0], "Hello client");
    }

    get list_struct1(): any[]
    {
        return [teststruct2(getTestVector("ts1.is_struct1.to_client", "double"))];
    }

    set list_struct1(value: any[])
    {
        assert.equal(value.length, 1);
        ca(value[0].mydat, getTestVector("ts1.is_struct1.to_service", "double"));
    }

    get var_num(): VarValue
    {
        return new VarValue(Int32Array.from(getTestVector("ts1.var_num.to_client", "int32")), "int32[]");
    }

    set var_num(value: VarValue)
    {
        cae(value.value, getTestVector("ts1.var_num.to_service", "int32"));
    }

    get var_str(): VarValue
    {
        return new VarValue("Hello Client!", "string");
    }

    set var_str(value: VarValue)
    {
        assert.equal(value.value, "Hello Server!");
    }

    get var_struct(): VarValue
    {
        return new VarValue(teststruct2(getTestVector("ts1.var_struct.to_client", "double")), `${T1}.teststruct2`);
    }

    set var_struct(value: VarValue)
    {
        ca((value.value as any).mydat, getTestVector("ts1.var_struct.to_service", "double"));
    }

    // Core's Python service sends string{int32}, string{string}, and string{list} values as maps
    // and lists of varvalue, so these are sent the same way

    get var_vector(): VarValue
    {
        return new VarValue(new Map([[10, new VarValue("Hello Client!", "string")]]), "varvalue{int32}");
    }

    set var_vector(value: VarValue)
    {
        const v = value.value as Map<number, VarValue>;
        assert.equal(v.size, 1);
        assert.equal(v.get(11)!.value, "Hello Server!");
    }

    get var_dictionary(): VarValue
    {
        return new VarValue(new Map([["test1", new VarValue("Hello Client!", "string")]]), "varvalue{string}");
    }

    set var_dictionary(value: VarValue)
    {
        const v = value.value as Map<string, VarValue>;
        assert.equal(v.size, 1);
        assert.equal(v.get("test2")!.value, "Hello Server!");
    }

    get var_list(): VarValue
    {
        return new VarValue([new VarValue("Hello Client!", "string")], "varvalue{list}");
    }

    set var_list(value: VarValue)
    {
        const v = value.value as VarValue[];
        assert.equal(v.length, 1);
        assert.equal(v[0]!.value, "Hello Server!");
    }

    get var_multidimarray(): VarValue
    {
        return new VarValue(mdv("ts1.var_multidimarray.to_client"), "double[*]");
    }

    set var_multidimarray(value: VarValue)
    {
        ca(value.value, mdv("ts1.var_multidimarray.to_service"));
    }

    get errtest(): number
    {
        throw new Error();
    }

    set errtest(_value: number)
    {
        throw new Error();
    }

    get nulltest(): null
    {
        return null;
    }

    set nulltest(value: unknown)
    {
        assert.equal(value, null);
    }

    // Functions

    func1(): void
    {
        setTimeout(() => this.ev1.fire(), 1000);
    }

    func2(d1: number, d2: number): void
    {
        setTimeout(() => this.ev2.fire(d1, teststruct2([d2])), 1000);
    }

    func3(d1: number, d2: number): number
    {
        // Core also prints the authenticated user and whether the connection is secure
        return d1 + d2;
    }

    meaning_of_life(): number
    {
        return 42;
    }

    func_errtest(): void
    {
        throw new Error("This is a test");
    }

    func_errtest1(): void
    {
        throw error(MessageErrorType.DataTypeError, "RobotRaconteur.DataTypeError", "This is a test 1");
    }

    func_errtest2(): void
    {
        throw error(MessageErrorType.RemoteError, `${T1}.testexception1`, "This is a test 2");
    }

    func_errtest3(): void
    {
        throw error(MessageErrorType.RemoteError, `${T2}.testexception3`, "This is a test 3");
    }

    // Objrefs

    get_o1(): [sub1_impl, string]
    {
        return [this._o1, `${T1}.sub1`];
    }

    get_o2(ind: number): [sub1_impl, string]
    {
        return [cached(this._o2, ind, () => Object.assign(new sub1_impl(), { i_ind: ind })), `${T1}.sub1`];
    }

    get_o3(ind: number): [sub1_impl, string]
    {
        return [cached(this._o3, ind, () => Object.assign(new sub1_impl(), { i_ind: ind })), `${T1}.sub1`];
    }

    get_o4(ind: string): [sub1_impl, string]
    {
        return [cached(this._o4, ind, () => Object.assign(new sub1_impl(), { s_ind: ind })), `${T1}.sub1`];
    }

    get_o5(): [sub1_impl, string]
    {
        return [this._o5, `${T1}.sub1`];
    }

    get_o6(): [unknown, string]
    {
        if (this._o6 instanceof sub1_impl) return [this._o6, `${T1}.sub1`];
        if (this._o6 instanceof sub2_impl) return [this._o6, `${T1}.sub2`];
        return [this._o6, `${T2}.subobj`];
    }

    o6_op(op: number): void
    {
        try
        {
            this.context!.releaseServicePath(this.service_path + ".o6");
        }
        catch
        {
            // Not requested yet
        }

        if (op === 0) this._o6 = new sub1_impl();
        else if (op === 1) this._o6 = new sub2_impl();
        else if (op === 2) this._o6 = new subobj_impl();
        else assert.fail("Unknown op number");
    }

}

function cached<K, V>(m: Map<K, V>, key: K, create: () => V): V
{
    let v = m.get(key);
    if (v === undefined)
    {
        v = create();
        m.set(key, v);
    }
    return v;
}

export class sub1_impl
{
    d1: unknown = null;
    d2: unknown = null;
    s_ind = "";
    i_ind = 0;

    private _o2_1 = new sub2_impl();
    private _o2_2 = new Map<number, sub2_impl>();
    private _o2_3 = new Map<string, sub2_impl>();

    get_o2_1(): [sub2_impl, string]
    {
        return [this._o2_1, `${T1}.sub2`];
    }

    get_o2_2(ind: number): [sub2_impl, string]
    {
        return [cached(this._o2_2, ind, () => Object.assign(new sub2_impl(), { i_ind: ind })), `${T1}.sub2`];
    }

    get_o2_3(ind: string): [sub2_impl, string]
    {
        return [cached(this._o2_3, ind, () => Object.assign(new sub2_impl(), { s_ind: ind })), `${T1}.sub2`];
    }
}

export class sub2_impl
{
    s_ind = "";
    i_ind = 0;
    data = "";

    private _o3_1 = new Map<string, sub3_impl>();

    get_o3_1(ind: string): [sub3_impl, string]
    {
        return [cached(this._o3_1, ind, () => Object.assign(new sub3_impl(), { ind })), `${T1}.sub3`];
    }
}

export class sub3_impl
{
    ind = "";
    data2 = "";
    data3 = 0;

    add(d: number): number
    {
        return d + 42;
    }
}

export class subobj_impl
{
    add_val(v: number): number
    {
        return v + 1;
    }
}
