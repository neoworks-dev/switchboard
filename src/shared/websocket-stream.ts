import type * as acp from "@agentclientprotocol/sdk";

/** The standard WebSocket surface: browsers, Node 22+, Bun and `ws` all have it. */
export type WebSocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
};

const OPEN = 1;

/**
 * An ACP stream over an open WebSocket, one JSON-RPC message per text frame.
 * Ending either side closes the socket.
 */
export function webSocketStream(socket: WebSocketLike): acp.Stream {
  let open = true;
  const end = () => {
    open = false;
    if (socket.readyState === OPEN) socket.close(1000);
  };
  return {
    readable: new ReadableStream({
      start(controller) {
        socket.addEventListener("message", ({ data }) => {
          if (!open) return;
          try {
            controller.enqueue(JSON.parse(String(data)));
          } catch {
            socket.close(1007, "invalid JSON");
          }
        });
        socket.addEventListener("close", () => {
          if (open) controller.close();
          open = false;
        });
        socket.addEventListener("error", () => {
          if (open) controller.error(new Error("WebSocket error"));
          open = false;
        });
      },
      cancel: end,
    }),
    writable: new WritableStream({
      write(message) {
        if (socket.readyState === OPEN) socket.send(JSON.stringify(message));
      },
      close: end,
      abort: end,
    }),
  };
}

/** Resolves once `socket` is open; rejects if it closes first, e.g. on a refused token. */
export function opened(socket: WebSocketLike & { addEventListener(type: "open", listener: () => void): void }): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === OPEN) return resolve();
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("close", () => reject(new Error("the sidecar refused the connection")));
  });
}
