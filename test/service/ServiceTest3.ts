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

// Port of Core's Python test service, test/python/RobotRaconteurTest/ServiceTest3.py. Core answers
// these members from its thread pool through handlers. Here the getters and functions return
// promises that settle after the current request has been handled.

import { RobotRaconteurError } from "robotraconteur";
import { MessageErrorType } from "robotraconteur/internal";

const T5 = "com.robotraconteur.testing.TestService5";

function later<T>(f: () => T): Promise<T>
{
    return new Promise((resolve, reject) => setImmediate(() =>
    {
        try
        {
            resolve(f());
        }
        catch (e)
        {
            reject(e);
        }
    }));
}

function invalidArgument(message = ""): RobotRaconteurError
{
    return new RobotRaconteurError(MessageErrorType.InvalidArgument, "RobotRaconteur.InvalidArgument", message);
}

function invalidOperation(message = ""): RobotRaconteurError
{
    return new RobotRaconteurError(MessageErrorType.InvalidOperation, "RobotRaconteur.InvalidOperation", message);
}

export class asynctestroot_impl
{
    get d1(): Promise<number>
    {
        return later(() => 8.5515);
    }

    set d1(value: number)
    {
        if (value !== 3.0819) throw invalidArgument();
    }

    get err(): Promise<number>
    {
        return later(() =>
        {
            throw invalidArgument("Test message 1");
        });
    }

    set err(_value: number)
    {
        throw invalidOperation();
    }

    f1(): Promise<void>
    {
        return later(() => undefined);
    }

    f2(a: number): Promise<void>
    {
        return later(() =>
        {
            if (a !== 247) throw invalidArgument();
        });
    }

    f3(a: number, b: number): Promise<number>
    {
        return later(() => Math.trunc(a + b));
    }

    err_func(): Promise<void>
    {
        return later(() =>
        {
            throw invalidOperation();
        });
    }

    err_func2(): Promise<number>
    {
        return later(() =>
        {
            throw new RobotRaconteurError(MessageErrorType.RemoteError, `${T5}.asynctestexp`, "");
        });
    }
}
