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

import { VarValue } from "robotraconteur";

/** How the conditions of a group combine, as in Core */
export type ServiceSubscriptionFilterAttributeGroupOperation = "or" | "and" | "nor" | "nand";

const NAME_REGEX = "(?:[a-zA-Z](?:[a-zA-Z0-9_]*[a-zA-Z0-9])?)(?:\\.[a-zA-Z](?:[a-zA-Z0-9_]*[a-zA-Z0-9])?)*";
const UUID_REGEX = "\\{?([a-fA-F0-9]{8})-?([a-fA-F0-9]{4})-?([a-fA-F0-9]{4})-?([a-fA-F0-9]{4})-?([a-fA-F0-9]{12})\\}?";

/** Core matches a regular expression against the entire value, not part of it */
function fullMatch(r: RegExp): RegExp
{
    return new RegExp(`^(?:${r.source})$`, r.flags.replace(/[gmy]/g, ""));
}

function unwrap(v: unknown): unknown
{
    return v instanceof VarValue ? v.value : v;
}

/** Matches one string value of an attribute, exactly or by a regular expression */
export class ServiceSubscriptionFilterAttribute
{
    /** The key to match in a map attribute. Empty matches any key, but only a list or string value otherwise */
    name = "";
    /** The value to match exactly, if valueRegex is not set */
    value = "";
    /** A regular expression the whole value must match */
    valueRegex: RegExp | null = null;

    /** Use (value) or (name, value). A value can be a string or a regular expression */
    constructor(a: string | RegExp = "", b?: string | RegExp)
    {
        const value = b === undefined ? a : b;
        if (b !== undefined) this.name = a as string;
        if (typeof value === "string") this.value = value;
        else this.valueRegex = fullMatch(value);
    }

    private valueMatches(value: string): boolean
    {
        return this.valueRegex ? this.valueRegex.test(value) : value === this.value;
    }

    /** Match a string, a list of values, or a map of values. Use (name, value) for one map entry */
    isMatch(a: string | unknown[] | Map<string, unknown>, value?: string): boolean
    {
        if (typeof a === "string")
        {
            if (value !== undefined) return (this.name === "" || this.name === a) && this.valueMatches(value);
            return this.name === "" && this.valueMatches(a);
        }
        if (a instanceof Map)
        {
            for (const [k, v] of a)
            {
                const s = unwrap(v);
                if (typeof s === "string" && this.isMatch(k, s)) return true;
            }
            return false;
        }
        return a.some((v) =>
        {
            const s = unwrap(v);
            return typeof s === "string" && this.isMatch(s);
        });
    }
}

/** Create an attribute matching a regular expression. Use (regex) or (name, regex) */
export function createServiceSubscriptionFilterAttributeRegex(a: string | RegExp, b?: string | RegExp): ServiceSubscriptionFilterAttribute
{
    const regex = (r: string | RegExp) => (typeof r === "string" ? new RegExp(r) : r);
    return b === undefined ? new ServiceSubscriptionFilterAttribute(regex(a)) : new ServiceSubscriptionFilterAttribute(a as string, regex(b));
}

function identifierToRegex(name: string, uuid_string: string): RegExp
{
    if (name === "" && uuid_string === "") throw new RangeError("Name and UUID string cannot both be empty");

    let out: string;
    if (name !== "")
    {
        if (!new RegExp(`^${NAME_REGEX}$`).test(name)) throw new RangeError("Invalid identifier name");
        out = name;
    }
    else
    {
        out = `(?:${NAME_REGEX}\\|)?`;
    }

    let zero_uuid = true;
    if (uuid_string !== "")
    {
        const m = new RegExp(`^${UUID_REGEX}$`).exec(uuid_string);
        if (!m) throw new RangeError("Invalid identifier UUID");
        const segments = m.slice(1);
        zero_uuid = segments.every((s) => /^0+$/.test(s));
        if (!zero_uuid)
        {
            const either_case = (s: string) => s.replace(/[a-zA-Z]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
            if (name !== "") out += "\\|";
            out += `\\{?${segments.map(either_case).join("-?")}\\}?`;
        }
    }

    if (zero_uuid)
    {
        if (name === "") throw new RangeError("Name and UUID string cannot both be empty");
        out += `(?:\\|${UUID_REGEX})?`;
    }
    return new RegExp(out);
}

function combinedIdentifierToRegex(combined: string): RegExp
{
    const m = new RegExp(`^(${NAME_REGEX})\\|(${UUID_REGEX})$`).exec(combined);
    if (m) return identifierToRegex(m[1]!, m[2]!);
    if (new RegExp(`^${UUID_REGEX}$`).test(combined)) return identifierToRegex("", combined);
    return identifierToRegex(combined, "");
}

/** Match a "name|uuid" identifier, given as "name", "uuid", or "name|uuid" */
export function createServiceSubscriptionFilterAttributeCombinedIdentifier(combined: string): ServiceSubscriptionFilterAttribute
{
    return new ServiceSubscriptionFilterAttribute(combinedIdentifierToRegex(combined));
}

/** Match a "name|uuid" identifier. Use (identifierName, uuid) or (attributeName, identifierName, uuid) */
export function createServiceSubscriptionFilterAttributeIdentifier(a: string, b: string, c?: string): ServiceSubscriptionFilterAttribute
{
    if (c === undefined) return new ServiceSubscriptionFilterAttribute(identifierToRegex(a, b));
    return new ServiceSubscriptionFilterAttribute(a, identifierToRegex(b, c));
}

/** Combines attributes and nested groups using an operation. An empty "or" or "and" group matches */
export class ServiceSubscriptionFilterAttributeGroup
{
    /** The values to match */
    attributes: ServiceSubscriptionFilterAttribute[] = [];
    /** Nested groups */
    groups: ServiceSubscriptionFilterAttributeGroup[] = [];
    /** Treat a string attribute as a list of values separated by the delimiter */
    splitStringAttribute = true;
    /** The separator of values in a string attribute */
    splitStringDelimiter = ",";

    /**
     * @param operation How the attributes and groups combine
     * @param items Attributes and groups to match
     */
    constructor(public operation: ServiceSubscriptionFilterAttributeGroupOperation = "or", items: (ServiceSubscriptionFilterAttribute | ServiceSubscriptionFilterAttributeGroup)[] = [])
    {
        for (const i of items)
        {
            if (i instanceof ServiceSubscriptionFilterAttributeGroup) this.groups.push(i);
            else this.attributes.push(i);
        }
    }

    private filter(operation: ServiceSubscriptionFilterAttributeGroupOperation, values: unknown[] | Map<string, unknown>): boolean
    {
        const empty = this.attributes.length === 0 && this.groups.length === 0;
        const matches = (e: ServiceSubscriptionFilterAttribute | ServiceSubscriptionFilterAttributeGroup) => e.isMatch(values);
        const all: (ServiceSubscriptionFilterAttribute | ServiceSubscriptionFilterAttributeGroup)[] = [...this.groups, ...this.attributes];
        switch (operation)
        {
        case "or":
            return empty || all.some(matches);
        case "and":
            return empty || all.every(matches);
        case "nor":
            return !this.filter("or", values);
        case "nand":
            return !this.filter("and", values);
        default:
            throw new RangeError("Invalid attribute filter operation");
        }
    }

    /** Match an attribute value. Only strings, lists, and maps can match. A missing value is an empty list */
    isMatch(value: unknown): boolean
    {
        const v = unwrap(value);
        if (v === null || v === undefined) return this.filter(this.operation, []);
        if (typeof v === "string") return this.filter(this.operation, this.splitStringAttribute ? v.split(this.splitStringDelimiter) : [v]);
        if (Array.isArray(v) || v instanceof Map) return this.filter(this.operation, v as unknown[] | Map<string, unknown>);
        return false;
    }
}

/** Check the attribute groups of a filter against the attributes of a service */
export function attributesMatch(groups: Map<string, ServiceSubscriptionFilterAttributeGroup> | Record<string, ServiceSubscriptionFilterAttributeGroup>, operation: ServiceSubscriptionFilterAttributeGroupOperation, attributes: Map<string, unknown>): boolean
{
    const entries = groups instanceof Map ? [...groups] : Object.entries(groups);
    const matches = entries.map(([name, group]) => group.isMatch(attributes.get(name) ?? null));
    switch (operation)
    {
    case "or":
        return matches.includes(true);
    case "nor":
        return !matches.includes(true);
    case "nand":
        return matches.includes(false);
    default:
        return !matches.includes(false);
    }
}
