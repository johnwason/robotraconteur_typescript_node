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
import type { EntryDefinition, MemberDefinition, MemberKind, ServiceDefinition, TypeDefinition } from "robotraconteur";
import { DataTypes, getElement, MessageElement, MessageEntry, MessageEntryType, MessageErrorType, packElement, unpackElement } from "robotraconteur/internal";
import { EventHook } from "./EventHook.js";
import { GENERATOR_CLOSED_TIMEOUT, GENERATOR_IDLE_TIMEOUT, toServiceGenerator } from "./Generators.js";
import type { ServiceGenerator } from "./Generators.js";
import type { ServerContext, ServerEndpoint } from "./ServerContext.js";

/** A service object, whose members are accessed by name as in Python */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ServiceObject = any;

export function serviceError(code: MessageErrorType, name: string, message: string): RobotRaconteurError
{
    return new RobotRaconteurError(code, "RobotRaconteur." + name, message);
}

function notImplemented(message: string): RobotRaconteurError
{
    return serviceError(MessageErrorType.NotImplementedError, "NotImplementedError", message);
}

function isGeneratorType(t: TypeDefinition | undefined): boolean
{
    return t?.container === "generator";
}

/** The type of the values of a generator */
function itemType(t: TypeDefinition): TypeDefinition
{
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { container, ...item } = t;
    return item;
}

interface GeneratorEntry
{
    generator: ServiceGenerator;
    endpoint: number;
    member: MemberDefinition;
    /** The generator is destroyed if it is not used again by this time */
    expires: number;
}

/**
 * Serves one object of a service, as Python does with a plain object. Properties are read and
 * written as attributes, functions are methods that may return a promise, an objref named x is
 * found by calling get_x(index), and each event member is an EventHook.
 */
export class ServiceSkel
{
    readonly def: ServiceDefinition;
    readonly entry: EntryDefinition;
    /** Set once the service has released the object */
    released = false;

    private members: Map<string, MemberDefinition>;
    private events: [EventHook, (...args: unknown[]) => void][] = [];
    private generators = new Map<number, GeneratorEntry>();

    constructor(readonly context: ServerContext, readonly servicePath: string, readonly obj: ServiceObject, readonly objectType: string)
    {
        const i = objectType.lastIndexOf(".");
        const def = context.node.serviceTypes.get(objectType.substring(0, i));
        const entry = def?.objects.find((o) => o.name === objectType.substring(i + 1));
        if (!def || !entry) throw serviceError(MessageErrorType.ServiceError, "ServiceError", "Unknown object type " + objectType);
        if (obj === null || typeof obj !== "object") throw serviceError(MessageErrorType.InvalidArgument, "InvalidArgument", `The object for ${servicePath} must be an object`);
        this.def = def;
        this.entry = entry;
        this.members = new Map(entry.members.map((m) => [m.name, m]));
    }

    /** Connect the events of the object and let it initialize, as Python's RRServiceObjectInit */
    init(): void
    {
        for (const m of this.entry.members)
        {
            if (m.kind !== "event") continue;
            let hook = this.obj[m.name] as unknown;
            if (hook === undefined || hook === null)
            {
                hook = new EventHook();
                this.obj[m.name] = hook;
            }
            if (!(hook instanceof EventHook)) throw serviceError(MessageErrorType.InvalidArgument, "InvalidArgument", `Event ${m.name} of ${this.objectType} must be an EventHook`);
            const handler = (...args: unknown[]) => this.sendEvent(m, args);
            hook.addHandler(handler);
            this.events.push([hook, handler]);
        }
        if (typeof this.obj.RRServiceObjectInit === "function") this.obj.RRServiceObjectInit(this.context, this.servicePath);
    }

    /** Stop sending events for the object */
    release(): void
    {
        this.released = true;
        for (const [hook, handler] of this.events) hook.removeHandler(handler);
        this.events = [];
        this.generators.clear();
    }

    /** Destroy generators that have not been used for a while, or that belong to a client that left */
    cleanupGenerators(now: number, endpoints?: ReadonlySet<number>): void
    {
        for (const [i, g] of this.generators)
        {
            if (now > g.expires || (endpoints && !endpoints.has(g.endpoint))) this.generators.delete(i);
        }
    }

    private member(name: string, kind: MemberKind): MemberDefinition
    {
        const m = this.members.get(name);
        if (!m || m.kind !== kind) throw serviceError(MessageErrorType.MemberNotFound, "MemberNotFound", `${this.objectType} has no ${kind} named ${name}`);
        return m;
    }

    private pack(name: string, t: TypeDefinition, v: unknown): MessageElement
    {
        return packElement(name, t, v, this.def, this.context.types);
    }

    private unpack(e: MessageElement, t: TypeDefinition): unknown
    {
        return unpackElement(e, t, this.def, this.context.types);
    }

    async getProperty(e: MessageEntry): Promise<MessageEntry>
    {
        const m = this.member(e.memberName, "property");
        if (m.modifiers?.includes("writeonly")) throw serviceError(MessageErrorType.WriteOnlyMember, "WriteOnlyMember", `Property ${m.name} is write only`);
        if (!(m.name in this.obj)) throw notImplemented(`Property ${m.name} is not implemented`);
        const v: unknown = await this.obj[m.name];
        const r = new MessageEntry(MessageEntryType.PropertyGetRes, m.name);
        r.addElement(this.pack("value", m.type!, v));
        return r;
    }

    async setProperty(e: MessageEntry): Promise<MessageEntry>
    {
        const m = this.member(e.memberName, "property");
        if (m.modifiers?.includes("readonly")) throw serviceError(MessageErrorType.ReadOnlyMember, "ReadOnlyMember", `Property ${m.name} is read only`);
        this.obj[m.name] = this.unpack(getElement(e.elements, "value"), m.type!);
        return new MessageEntry(MessageEntryType.PropertySetRes, m.name);
    }

    /**
     * Call a function. A generator function, which returns a generator or takes one as its last
     * parameter, is called without that parameter and returns the generator. The client then
     * steps it with GeneratorNextReq
     */
    async callFunction(e: MessageEntry, ep: ServerEndpoint): Promise<MessageEntry>
    {
        const m = this.member(e.memberName, "function");
        const f = this.obj[m.name] as unknown;
        if (typeof f !== "function") throw notImplemented(`Function ${m.name} is not implemented`);
        const params = m.parameters ?? [];
        const generator_param = isGeneratorType(params[params.length - 1]?.type);
        const decl = generator_param ? params.slice(0, -1) : params;
        const args = decl.map((p) => this.unpack(getElement(e.elements, p.name), p.type));
        const ret: unknown = await f.apply(this.obj, args);

        const r = new MessageEntry(MessageEntryType.FunctionCallRes, m.name);
        if (generator_param || isGeneratorType(m.type))
        {
            const index = this.addGenerator(toServiceGenerator(ret, m.name), m, ep);
            r.addElement(new MessageElement("index", DataTypes.int32_t, Int32Array.of(index)));
        }
        else if (m.type!.type === "void") r.addElement(new MessageElement("return", DataTypes.void_t, null));
        else r.addElement(this.pack("return", m.type!, ret));
        return r;
    }

    private addGenerator(generator: ServiceGenerator, member: MemberDefinition, ep: ServerEndpoint): number
    {
        let index: number;
        do
        {
            index = Math.floor(Math.random() * 0x7fffffff);
        } while (this.generators.has(index));
        this.generators.set(index, { generator, endpoint: ep.localEndpoint, member, expires: Date.now() + GENERATOR_IDLE_TIMEOUT });
        return index;
    }

    /**
     * Step a generator, or close or abort it when the request carries StopIteration or another
     * error, as Core does. The generator is destroyed when it reports an error, including
     * StopIteration at its end, and shortly after it is closed or aborted.
     */
    async callGeneratorNext(e: MessageEntry, ep: ServerEndpoint): Promise<MessageEntry>
    {
        const index = (getElement(e.elements, "index").data as Int32Array)[0]!;
        const g = this.generators.get(index);
        if (!g || g.endpoint !== ep.localEndpoint || g.member.name !== e.memberName)
        {
            throw serviceError(MessageErrorType.InvalidOperation, "InvalidOperation", "Invalid generator");
        }
        g.expires = Date.now() + (e.error === MessageErrorType.None ? GENERATOR_IDLE_TIMEOUT : GENERATOR_CLOSED_TIMEOUT);

        const r = new MessageEntry(MessageEntryType.GeneratorNextRes, e.memberName);
        try
        {
            if (e.error !== MessageErrorType.None)
            {
                if (e.error === MessageErrorType.StopIteration) await g.generator.close();
                else await g.generator.abort();
                r.addElement(new MessageElement("return", DataTypes.int32_t, Int32Array.of(0)));
                return r;
            }

            const params = g.member.parameters ?? [];
            const param_type = params[params.length - 1]?.type;
            const param = isGeneratorType(param_type) ? this.unpack(getElement(e.elements, "parameter"), itemType(param_type!)) : undefined;
            const v = await g.generator.next(param);
            const ret_type = g.member.type!;
            if (isGeneratorType(ret_type)) r.addElement(this.pack("return", itemType(ret_type), v));
            else r.addElement(new MessageElement("return", DataTypes.int32_t, Int32Array.of(0)));
            return r;
        }
        catch (err)
        {
            this.generators.delete(index);
            throw err;
        }
    }

    /**
     * The object of an objref, from get_<name>(index). It returns the object, or [object, type]
     * when the type is not the declared one, which is required for varobject.
     */
    async getSubObj(name: string, index: string | undefined): Promise<{ obj: ServiceObject; type: string }>
    {
        const m = this.member(name, "objref");
        const t = m.type!;
        const indexed = t.array !== undefined || t.container === "map_int32" || t.container === "map_string";
        if (indexed !== (index !== undefined)) throw serviceError(MessageErrorType.ObjectNotFound, "ObjectNotFound", `Invalid index for objref ${name}`);

        let arg: string | number | undefined = index;
        if (index !== undefined && t.container !== "map_string")
        {
            if (!/^-?\d+$/.test(index)) throw serviceError(MessageErrorType.ObjectNotFound, "ObjectNotFound", `Invalid index for objref ${name}`);
            arg = Number(index);
        }

        const getter = this.obj["get_" + name] as unknown;
        if (typeof getter !== "function") throw serviceError(MessageErrorType.ObjectNotFound, "ObjectNotFound", `Objref ${name} is not implemented. Add a get_${name} method`);
        const ret: unknown = await (arg === undefined ? getter.call(this.obj) : getter.call(this.obj, arg));

        let sub: unknown = ret;
        let type = t.type;
        if (Array.isArray(ret))
        {
            sub = ret[0];
            type = String(ret[1]);
        }
        if (sub === null || sub === undefined) throw serviceError(MessageErrorType.ObjectNotFound, "ObjectNotFound", `Object not found for objref ${name}`);
        if (type === "varobject") throw serviceError(MessageErrorType.ServiceError, "ServiceError", `get_${name} must return [object, type] for a varobject objref`);

        const r = this.context.types.resolve(type, this.def);
        if (r.kind !== "object") throw serviceError(MessageErrorType.ServiceError, "ServiceError", `${type} is not an object type`);
        return { obj: sub, type: r.qualifiedName };
    }

    private sendEvent(m: MemberDefinition, args: unknown[]): void
    {
        if (this.released) return;
        const e = new MessageEntry(MessageEntryType.EventReq, m.name);
        e.servicePath = this.servicePath;
        e.elements = (m.parameters ?? []).map((p, i) => this.pack(p.name, p.type, args[i]));
        this.context.sendEvent(e);
    }
}
