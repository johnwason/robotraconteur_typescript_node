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

/**
 * An event of a service object, as Python's EventHook. A service fires it to send the event to
 * every connected client. The node assigns one to each event member that does not have one.
 */
export class EventHook<T extends unknown[] = any[]>
{
    private handlers = new Set<(...args: T) => void>();

    addHandler(handler: (...args: T) => void): void
    {
        this.handlers.add(handler);
    }

    removeHandler(handler: (...args: T) => void): void
    {
        this.handlers.delete(handler);
    }

    /** Call every handler. An error in one handler does not stop the others */
    fire(...args: T): void
    {
        for (const h of [...this.handlers])
        {
            try
            {
                h(...args);
            }
            catch (e)
            {
                console.error("Error in event handler:", e);
            }
        }
    }
}
