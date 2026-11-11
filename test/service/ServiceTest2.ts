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

// Port of Core's Python test service, test/python/RobotRaconteurTest/ServiceTest2.py. The fill
// and verify functions are shared with the client tests in the robotraconteur package.
// Generators, wires, and memories are not ported yet, because robotraconteur-node services do not
// support them yet.

import assert from "node:assert/strict";
import { RobotRaconteurError, VarValue } from "robotraconteur";
import { MessageErrorType } from "robotraconteur/internal";
import * as st from "@shared/test/common/ServiceTest2.js";
import { getTestVector } from "@shared/test/common/TestVectors.js";
import { ca, md } from "@shared/test/common/TestUtil.js";
import type { ServerContext } from "../../src/index.js";

const T3 = "com.robotraconteur.testing.TestService3";

function mdv(name: string, type = "double"): any
{
    return md(getTestVector(name, type), getTestVector(name + ".dims", "uint32"));
}

function exceptionParams(param1: number, param2: string): VarValue
{
    return new VarValue(new Map([["param1", new VarValue(Int32Array.of(param1), "int32")], ["param2", new VarValue(param2, "string")]]), "varvalue{string}");
}

export class testroot3_impl
{
    private _o5 = new obj5_impl();
    private testenum1 = new Map<string, number>();

    RRServiceObjectInit(context: ServerContext): void
    {
        const def = context.node.serviceTypes.get(T3)!;
        for (const v of def.enums.find((e) => e.name === "testenum1")!.values) this.testenum1.set(v.name, v.value);
    }

    get testenum1_prop(): number
    {
        return this.testenum1.get("anothervalue")!;
    }

    set testenum1_prop(value: number)
    {
        assert.equal(value, this.testenum1.get("hexval1"));
    }

    get testpod1_prop(): any
    {
        return st.ServiceTest2_fill_testpod1(563921043);
    }

    set testpod1_prop(value: any)
    {
        st.ServiceTest2_verify_testpod1(value, 85932659);
    }

    testpod1_func1(s: any): void
    {
        st.ServiceTest2_verify_testpod1(s, 29546592);
    }

    testpod1_func2(): any
    {
        return st.ServiceTest2_fill_testpod1(95836295);
    }

    get teststruct3_prop(): any
    {
        return st.ServiceTest2_fill_teststruct3(16483675);
    }

    set teststruct3_prop(value: any)
    {
        st.ServiceTest2_verify_teststruct3(value, 858362);
    }

    get_o4(): [obj4_impl, string]
    {
        return [new obj4_impl(), `${T3}.obj4`];
    }

    get testnamedarray1(): any
    {
        return st.ServiceTest2_fill_transform(74637).translation;
    }

    set testnamedarray1(value: any)
    {
        const a1 = st.ServiceTest2_fill_transform(3956378);
        a1.translation = value;
        st.ServiceTest2_verify_transform(a1, 3956378);
    }

    get testnamedarray2(): any
    {
        return st.ServiceTest2_fill_transform(1294);
    }

    set testnamedarray2(value: any)
    {
        st.ServiceTest2_verify_transform(value, 827635);
    }

    get testnamedarray3(): any
    {
        return st.ServiceTest2_create_transform_array(8, 837512);
    }

    set testnamedarray3(value: any)
    {
        st.ServiceTest2_verify_transform_array(value, 6, 19274);
    }

    get testnamedarray4(): any
    {
        return st.ServiceTest2_create_transform_multidimarray(7, 2, 66134);
    }

    set testnamedarray4(value: any)
    {
        st.ServiceTest2_verify_transform_multidimarray(value, 5, 2, 6385);
    }

    get testnamedarray5(): any
    {
        return st.ServiceTest2_create_transform_multidimarray(3, 2, 773142);
    }

    set testnamedarray5(value: any)
    {
        st.ServiceTest2_verify_transform_multidimarray(value, 3, 2, 7732);
    }

    // Complex values are { real, imag }, and complex arrays are interleaved real and imaginary parts

    get c1(): any
    {
        return { real: 5.708705e+01, imag: -2.328294e-03 };
    }

    set c1(value: any)
    {
        ca(value, { real: 5.708705e+01, imag: -2.328294e-03 });
    }

    get c2(): any
    {
        return getTestVector("ts3.c2.to_client", "double");
    }

    set c2(value: any)
    {
        ca(value, getTestVector("ts3.c2.to_service", "double"));
    }

    get c3(): any
    {
        return mdv("ts3.c3.to_client");
    }

    set c3(value: any)
    {
        ca(value, mdv("ts3.c3.to_service"));
    }

    get c5(): any
    {
        return [getTestVector("ts3.c5.to_client", "double")];
    }

    set c5(value: any)
    {
        ca(value[0], getTestVector("ts3.c5.to_service", "double"));
    }

    get c7(): any
    {
        return { real: -5.527021e-18, imag: -9.848457e+03 };
    }

    set c7(value: any)
    {
        ca(value, { real: 9.303345e-12, imag: -3.865684e-05 });
    }

    get c8(): any
    {
        return getTestVector("ts3.c8.to_client", "single");
    }

    set c8(value: any)
    {
        ca(value, getTestVector("ts3.c8.to_service", "single"));
    }

    get c9(): any
    {
        return mdv("ts3.c9.to_client", "single");
    }

    set c9(value: any)
    {
        ca(value, mdv("ts3.c9.to_service", "single"));
    }

    get_nolock_test(): [obj5_impl, string]
    {
        return [this._o5, `${T3}.obj5`];
    }

    get b1(): boolean
    {
        return true;
    }

    set b1(value: boolean)
    {
        assert.equal(value, true);
    }

    get b2(): boolean[]
    {
        return [true, false, true, true, false, true, false];
    }

    set b2(value: any)
    {
        ca(value, [true, false, false, true, true, true, false, true]);
    }

    get b3(): any
    {
        return md([false, true, true, false], [2, 2]);
    }

    set b3(value: any)
    {
        ca(value, md([true, false], [2, 1]));
    }

    get b4(): boolean[]
    {
        return [true];
    }

    set b4(value: boolean[])
    {
        assert.equal(value[0], true);
    }

    get b5(): boolean[][]
    {
        return [[false, true, false, false]];
    }

    set b5(value: any)
    {
        ca(value[0], [true, false]);
    }

    get b6(): any[]
    {
        return [md([false, true, true, false], [2, 2])];
    }

    set b6(value: any)
    {
        ca(value[0], md([true, false], [2, 1]));
    }

    test_exception_params1(): void
    {
        const err = new RobotRaconteurError(MessageErrorType.InvalidOperation, "RobotRaconteur.InvalidOperation", "test error");
        err.errorSubName = "my_error";
        err.errorParam = exceptionParams(10, "20");
        throw err;
    }

    test_exception_params2(): void
    {
        const err = new RobotRaconteurError(MessageErrorType.RemoteError, `${T3}.test_exception4`, "test error2");
        err.errorSubName = "my_error2";
        err.errorParam = exceptionParams(30, "40");
        throw err;
    }
}

export class obj4_impl
{
    s_ind = "";
    i_ind = 0;
    data = "";
}

export class obj5_impl
{
    p1 = 0;
    p2 = 0;
    p3 = 0;

    f1(): number
    {
        return 10;
    }

    f2(): number
    {
        return 11;
    }
}
