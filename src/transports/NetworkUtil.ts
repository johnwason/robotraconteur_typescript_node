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

import type { NetworkInterfaceInfo } from "node:os";

/** The zone of an IPv6 address: an interface name, except on Windows where it is a number */
export function interfaceScope(name: string, address: NetworkInterfaceInfo): string
{
    return process.platform === "win32" ? String((address as { scopeid?: number }).scopeid ?? 0) : name;
}

export function isIPv6LinkLocal(address: string): boolean
{
    return /^fe[89ab]/i.test(address);
}

export function isIPv6SiteLocal(address: string): boolean
{
    return /^fe[c-f]/i.test(address);
}

export function isLoopback(address: string): boolean
{
    return address === "::1" || address.startsWith("127.");
}
