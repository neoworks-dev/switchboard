// Transparent proxy that records harness request bodies (never headers) to disk.
// Point a harness at http://127.0.0.1:8787/<label> and captures land in ./captures/<label>/.
const UPSTREAM = process.env.UPSTREAM ?? "https://api.anthropic.com";
const OUT = process.env.OUT ?? "./captures";
const PORT = Number(process.env.PORT ?? 8787);

let n = 0;

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const [, label, ...rest] = url.pathname.split("/");
    const path = "/" + rest.join("/");
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();

    if (body) {
      const file = `${OUT}/${label}/${String(++n).padStart(3, "0")}${path.replaceAll("/", "_")}.json`;
      await Bun.write(file, body);
      console.log(`${req.method} ${label} ${path} -> ${file}`);
    }

    const headers = new Headers(req.headers);
    headers.delete("host");
    // Upstream must not compress: fetch decodes the body but keeps content-encoding, which breaks the client.
    headers.delete("accept-encoding");

    return fetch(UPSTREAM + path + url.search, { method: req.method, headers, body });
  },
});

console.log(`capture proxy on http://127.0.0.1:${PORT}/<label> -> ${UPSTREAM}`);
