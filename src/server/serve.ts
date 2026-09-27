import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { webSocketStream } from "../shared/websocket-stream.ts";
import type { HarnessApi } from "../types.ts";
import { serveConnection } from "./connection.ts";

export type ServeOptions = {
  harness: HarnessApi;
  /** Defaults to 127.0.0.1. Anything else exposes your subscriptions to the network. */
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  /**
   * Clients must send it as `?token=` (browsers can't set WebSocket headers) or
   * `Authorization: Bearer`. Any web page can open a socket to localhost, so
   * there is always one; omitted, a random one is made.
   */
  token?: string;
};

export type Sidecar = {
  /** `ws://host:port` without the token. */
  url: string;
  token: string;
  close(): Promise<void>;
};

/** Serve `harness` over ACP on a WebSocket, one ACP connection per socket. */
export async function serve({ harness, host = "127.0.0.1", port = 0, token = randomBytes(24).toString("base64url") }: ServeOptions): Promise<Sidecar> {
  const http = createServer((_request, response) => response.writeHead(426).end("WebSocket only\n"));
  const sockets = new WebSocketServer({
    server: http,
    verifyClient: ({ req }: { req: IncomingMessage }) => authorized(req, token),
  });
  const connections = new Set<Promise<void>>();
  sockets.on("connection", (socket) => {
    const served = serveConnection(harness, webSocketStream(socket));
    // The ACP connection doesn't see the socket go away on its own.
    socket.on("close", () => served.close());
    const done = served.closed.finally(() => connections.delete(done));
    connections.add(done);
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, resolve);
  });
  const address = http.address() as AddressInfo;

  return {
    url: `ws://${host}:${address.port}`,
    token,
    async close() {
      // Shutting down: no closing handshake with clients that may be gone already.
      for (const socket of sockets.clients) socket.terminate();
      await Promise.all(connections);
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      // Every socket is gone; stop listening without awaiting the callback,
      // which Bun never fires once a connection was upgraded.
      http.close();
      http.closeAllConnections();
    },
  };
}

function authorized(request: IncomingMessage, token: string): boolean {
  const url = new URL(request.url ?? "/", "http://localhost");
  const header = request.headers.authorization?.replace(/^Bearer /, "");
  const offered = url.searchParams.get("token") ?? header ?? "";
  const expected = Buffer.from(token);
  const actual = Buffer.from(offered);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
