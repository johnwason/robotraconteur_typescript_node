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

import { RobotRaconteurError } from "robotraconteur";
import { MessageErrorType } from "robotraconteur/internal";

/** Generators are destroyed after this long without a request, as in Core */
export const GENERATOR_IDLE_TIMEOUT = 600000;
/** Generators are destroyed this long after the client closes or aborts them, as in Core */
export const GENERATOR_CLOSED_TIMEOUT = 30000;

export function stopIteration(): RobotRaconteurError
{
    return new RobotRaconteurError(MessageErrorType.StopIteration, "RobotRaconteur.StopIteration", "");
}

function operationAborted(): RobotRaconteurError
{
    return new RobotRaconteurError(MessageErrorType.OperationAborted, "RobotRaconteur.OperationAborted", "Generator aborted");
}

/** The operations of a generator returned by a service function */
export interface ServiceGenerator
{
    next(param: unknown): Promise<unknown>;
    close(): Promise<void>;
    abort(): Promise<void>;
}

type Iter = { next(v?: unknown): unknown; return?(v?: unknown): unknown };

/**
 * Adapt what a generator function returned. As in Python, it may be an object with Next(param) and
 * optionally Close() and Abort(), or anything iterable, such as an array or a generator, which
 * may be asynchronous. A function that takes a generator parameter should return an object with
 * Next, since a JavaScript generator does not receive the value of its first step.
 */
export function toServiceGenerator(v: unknown, name: string): ServiceGenerator
{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const o = v as any;
    let closed = false;
    let aborted = false;
    const check = () =>
    {
        if (aborted) throw operationAborted();
        if (closed) throw stopIteration();
    };

    if (o !== null && typeof o === "object" && typeof o.Next === "function")
    {
        return {
            async next(param)
            {
                // Only set when the object has no Close or Abort of its own
                check();
                return await o.Next(param);
            },
            async close()
            {
                if (typeof o.Close === "function") await o.Close();
                else closed = true;
            },
            async abort()
            {
                if (typeof o.Abort === "function") await o.Abort();
                else aborted = true;
            }
        };
    }

    let it: Iter | undefined;
    if (o !== null && o !== undefined)
    {
        if (typeof o[Symbol.asyncIterator] === "function") it = o[Symbol.asyncIterator]();
        else if (typeof o[Symbol.iterator] === "function") it = o[Symbol.iterator]();
        else if (typeof o.next === "function") it = o as Iter;
    }
    if (!it)
    {
        throw new RobotRaconteurError(MessageErrorType.InvalidOperation, "RobotRaconteur.InvalidOperation",
            `Generator function ${name} must return an iterable, or an object with a Next method`);
    }
    const iter = it;
    const finish = async () =>
    {
        await iter.return?.();
    };
    return {
        async next(param)
        {
            check();
            const r = (await iter.next(param)) as IteratorResult<unknown>;
            if (r.done)
            {
                closed = true;
                throw stopIteration();
            }
            return r.value;
        },
        async close()
        {
            closed = true;
            await finish();
        },
        async abort()
        {
            aborted = true;
            await finish();
        }
    };
}
