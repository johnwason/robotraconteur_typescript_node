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
import type { MemberDefinition } from "robotraconteur";
import { entryToError, getElement, MessageEntry, MessageEntryType, MessageErrorType } from "robotraconteur/internal";
import type { ServerEndpoint } from "./ServerContext.js";
import type { ServiceSkel } from "./ServiceSkel.js";

/**
 * A callback member of a service object, which calls a function that a client has set. The node
 * puts one on each callback member, as Python does.
 */
export class Callback<R = unknown>
{
    /**
     * @internal Created by the node for each callback member
     *
     * @param member The callback member's definition
     */
    constructor(private skel: ServiceSkel, readonly member: MemberDefinition) {}

    /**
     * A function that calls the callback on one client, as Python's GetClientFunction. The client
     * is a ServerEndpoint, such as ServerEndpoint.current, or its local endpoint number. The
     * function returns a promise of the callback's return value, and rejects with the client's
     * error, or if the client does not answer within the node's requestTimeout.
     */
    getClientFunction(endpoint: ServerEndpoint | number): (...args: unknown[]) => Promise<R>
    {
        const context = this.skel.context;
        const ep = typeof endpoint === "number" ? context.getClient(endpoint) : endpoint;
        if (!ep || ep.context !== context || !context.getClient(ep.localEndpoint))
        {
            throw new RobotRaconteurError(MessageErrorType.InvalidArgument, "RobotRaconteur.InvalidArgument", "Invalid endpoint for callback");
        }
        const m = this.member;
        const params = m.parameters ?? [];
        return async (...args: unknown[]): Promise<R> =>
        {
            if (args.length !== params.length)
            {
                throw new RobotRaconteurError(MessageErrorType.InvalidArgument, "RobotRaconteur.InvalidArgument", `Callback ${m.name} expects ${params.length} parameters`);
            }
            const e = new MessageEntry(MessageEntryType.CallbackCallReq, m.name);
            e.servicePath = this.skel.servicePath;
            params.forEach((p, i) => e.addElement(this.skel.pack(p.name, p.type, args[i])));
            const r = await ep.request(e);
            if (r.error !== MessageErrorType.None) throw entryToError(r, context.types);
            if (m.type!.type === "void") return undefined as R;
            return this.skel.unpack(getElement(r.elements, "return"), m.type!) as R;
        };
    }
}
