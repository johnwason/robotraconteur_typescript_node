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

import type { Socket } from "node:net";
import { connectionError } from "robotraconteur/internal";
import type { SocketAdapter } from "robotraconteur/internal";

/** The WebSocket subprotocol of Robot Raconteur, which both sides must agree on */
export const WEBSOCKET_PROTOCOL = "robotraconteur.robotraconteur.com";
/** A send waits for the data to reach the socket once this many bytes are queued, as for a TCP socket */
const WEBSOCKET_SEND_HIGH_WATER_MARK = 16 * 1024;

/** A connected net.Socket or TLS socket, using the write return value and drain event for backpressure */
export class TcpSocketAdapter implements SocketAdapter
{
    constructor(private socket: Socket) {}

    write(frame: Uint8Array): Promise<void> | void
    {
        if (this.socket.write(frame)) return;
        return new Promise<void>((resolve, reject) =>
        {
            const cleanup = () =>
            {
                this.socket.off("drain", on_drain);
                this.socket.off("close", on_close);
            };
            const on_drain = () =>
            {
                cleanup();
                resolve();
            };
            const on_close = () =>
            {
                cleanup();
                reject(connectionError("Transport connection closed"));
            };
            this.socket.once("drain", on_drain);
            this.socket.once("close", on_close);
        });
    }

    close(): void
    {
        this.socket.destroy();
    }
}

/** The parts of a WebSocket from the ws package that are used, so that its types are not needed by users */
/**
 * What the transport uses of a WebSocket from the ws library. A server's WebSocket must also be an
 * EventEmitter with its message, error, and close events
 */
export interface WsLike
{
    /** The WebSocket state, 1 when open */
    readonly readyState: number;
    /** Bytes queued to send */
    readonly bufferedAmount: number;
    /** Send binary data, calling cb once it has been written or has failed */
    send(data: Uint8Array, options: { binary: boolean }, cb: (err?: Error) => void): void;
    /** Close the socket at once */
    terminate(): void;
}

/** A WebSocket from the ws package. Each send reports when its data has been written to the socket */
export class WebSocketAdapter implements SocketAdapter
{
    constructor(private ws: WsLike) {}

    write(frame: Uint8Array): Promise<void> | void
    {
        if (this.ws.readyState !== 1) return Promise.reject(connectionError("Transport connection closed"));
        const sent = new Promise<void>((resolve, reject) =>
        {
            this.ws.send(frame, { binary: true }, (e) => (e ? reject(connectionError("Transport connection closed")) : resolve()));
        });
        // Like a socket write, continue at once while little is queued, and otherwise wait for it to be sent
        if (this.ws.bufferedAmount < WEBSOCKET_SEND_HIGH_WATER_MARK)
        {
            sent.catch(() => undefined);
            return;
        }
        return sent;
    }

    close(): void
    {
        this.ws.terminate();
    }
}
