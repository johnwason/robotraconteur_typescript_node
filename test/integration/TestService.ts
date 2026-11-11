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

// A service implemented in TypeScript, for testing the server with TypeScript and Core clients.

import { RobotRaconteurError, VarValue } from "robotraconteur";
import { EventHook, ServerEndpoint } from "../../src/index.js";
import type { Callback, ServerContext } from "../../src/index.js";

export const TEST_SERVICE_DEF = `## A service for testing robotraconteur-node services
service experimental.ts_service_test

stdver 0.10

enum mode
    idle = 0,
    run = 1,
    fault = 5
end

exception test_error

struct point
    field double x
    field double y
end

## The root object
object testroot
    property double d1
    property int32[] ia
    property string s1 [readonly]
    property point p1
    property mode m1
    property varvalue v1
    property double w1 [writeonly]
    property string{string} smap
    ## Add two numbers
    function double add(double a, double b)
    function double add_slowly(double a, double b)
    function void set_s1(string s)
    function point make_point(double x, double y)
    function void fail_rr(string message)
    function void fail_plain(string message)
    function void fire_event(string message, double value)
    function uint32 current_endpoint()
    function int32 calls()
    function void release_o1()
    function int32{generator} count_to(int32 n)
    function double{generator} scale(double factor, double{generator} values)
    function int32{generator} not_a_generator()
    callback double cb_add(double a, double b)
    function double call_cb_add(double a, double b)
    function void call_cb_endpoint(uint32 endpoint)
    event ev1(string message, double value)
    objref sub o1
    objref sub{int32} o2
    objref sub{string} o3
    objref varobject o4
    objref sub missing
    wire double w [readonly]
end

object sub
    property string name
    function string path()
    objref sub child
end
`;

export class Sub
{
    path_value = "";
    private child: Sub | null = null;

    constructor(public name: string) {}

    RRServiceObjectInit(_context: ServerContext, path: string): void
    {
        this.path_value = path;
    }

    path(): string
    {
        return this.path_value;
    }

    get_child(): Sub
    {
        this.child ??= new Sub(this.name + ".child");
        return this.child;
    }
}

export class TestRoot
{
    d1 = 1.5;
    ia = Int32Array.of(1, 2, 3);
    s1 = "hello";
    p1 = { x: 1, y: 2 };
    m1 = 1;
    v1: VarValue | null = new VarValue("a string", "string");
    smap = new Map([["a", "x"]]);
    ev1!: EventHook<[string, number]>;
    cb_add!: Callback<number>;
    w1_value = 0;
    context: ServerContext | null = null;
    private o1 = new Sub("o1");
    private n_calls = 0;
    released_o1 = 0;

    set w1(v: number)
    {
        this.w1_value = v;
    }

    RRServiceObjectInit(context: ServerContext): void
    {
        this.context = context;
    }

    add(a: number, b: number): number
    {
        this.n_calls++;
        return a + b;
    }

    async add_slowly(a: number, b: number): Promise<number>
    {
        await new Promise((r) => setTimeout(r, 50));
        return a + b;
    }

    set_s1(s: string): void
    {
        this.s1 = s;
    }

    make_point(x: number, y: number): { x: number; y: number }
    {
        return { x, y };
    }

    fail_rr(message: string): void
    {
        const e = new RobotRaconteurError(18, "RobotRaconteur.InvalidArgument", message);
        e.errorSubName = "test.sub";
        e.errorParam = new VarValue(Float64Array.of(4, 5), "double[]");
        throw e;
    }

    fail_plain(message: string): void
    {
        throw new TypeError(message);
    }

    fire_event(message: string, value: number): void
    {
        this.ev1.fire(message, value);
    }

    current_endpoint(): number
    {
        return ServerEndpoint.current?.localEndpoint ?? 0;
    }

    calls(): number
    {
        return this.n_calls;
    }

    release_o1(): void
    {
        this.o1 = new Sub("o1 again");
        this.released_o1++;
        this.context!.releaseServicePath("test.o1");
    }

    async *count_to(n: number): AsyncGenerator<number>
    {
        for (let i = 0; i < n; i++)
        {
            await new Promise((r) => setImmediate(r));
            yield i;
        }
    }

    /** A generator in the Python form, without Close or Abort */
    scale(factor: number): { Next(v: number): number }
    {
        return { Next: (v: number) => v * factor };
    }

    not_a_generator(): number
    {
        return 5;
    }

    call_cb_add(a: number, b: number): Promise<number>
    {
        return this.cb_add.getClientFunction(ServerEndpoint.current!)(a, b);
    }

    async call_cb_endpoint(endpoint: number): Promise<void>
    {
        await this.cb_add.getClientFunction(endpoint)(1, 2);
    }

    get_o1(): Sub
    {
        return this.o1;
    }

    get_o2(index: number): Sub
    {
        return new Sub("o2 " + String(index));
    }

    async get_o3(key: string): Promise<Sub>
    {
        return new Sub("o3 " + key);
    }

    get_o4(): [Sub, string]
    {
        return [new Sub("o4"), "experimental.ts_service_test.sub"];
    }
}
