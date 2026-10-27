import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.mjs";
import { bus, getSession, listSessions, eventsSince, settled } from "./db.mjs";
import { reconcile, refill, listBoxes } from "./pool.mjs";
import { createSession, sendMessage, cancelSession, schedule, recover, sleepExpired } from "./runner.mjs";

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
};

const authorized = (req) => {
  if (!config.apiToken) return true;
  const got = Buffer.from((req.headers.authorization || "").replace(/^Bearer /, ""));
  const want = Buffer.from(config.apiToken);
  return got.length === want.length && timingSafeEqual(got, want);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
  });

// Server-sent events: replay stored events after ?after=<seq>, then stream live ones until the session settles
// (idle, sleeping, failed or cancelled, with no follow-up waiting).
function streamEvents(req, res, id) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (ev) => res.write(`id: ${ev.seq}\nevent: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`);
  const after = Number(new URL(req.url, "http://x").searchParams.get("after") || req.headers["last-event-id"] || 0);
  for (const ev of eventsSince(id, after)) send(ev);
  if (settled(id)) return res.end();
  const stop = () => { bus.off(`session:${id}`, onEvent); clearInterval(ping); if (!res.writableEnded) res.end(); };
  const onEvent = (ev) => { send(ev); if (ev.kind === "status" && settled(id)) stop(); };
  bus.on(`session:${id}`, onEvent);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", stop);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/healthz") return json(res, 200, { ok: true });
    if (!authorized(req)) return json(res, 401, { error: "unauthorized" });

    const m = url.pathname.match(/^\/sessions\/([\w-]+)(\/events|\/cancel|\/messages)?$/);
    if (req.method === "POST" && url.pathname === "/sessions") {
      const b = await readBody(req);
      if (!b.prompt || !b.repo) return json(res, 400, { error: "prompt and repo are required" });
      return json(res, 201, createSession({ prompt: b.prompt, repo: b.repo, baseBranch: b.baseBranch, requestedBy: b.requestedBy, source: b.source }));
    }
    if (req.method === "GET" && url.pathname === "/sessions") return json(res, 200, listSessions());
    if (req.method === "GET" && url.pathname === "/pool") return json(res, 200, listBoxes());
    if (m && req.method === "GET" && !m[2]) {
      const s = getSession(m[1]);
      return s ? json(res, 200, s) : json(res, 404, { error: "not found" });
    }
    if (m && req.method === "GET" && m[2] === "/events") return getSession(m[1]) ? streamEvents(req, res, m[1]) : json(res, 404, { error: "not found" });
    if (m && req.method === "POST" && m[2] === "/messages") {
      const b = await readBody(req);
      if (!b.prompt) return json(res, 400, { error: "prompt is required" });
      try {
        const r = sendMessage(m[1], { prompt: b.prompt, author: b.author });
        return r ? json(res, 202, r) : json(res, 404, { error: "not found" });
      } catch (e) {
        return json(res, 409, { error: e.message });
      }
    }
    if (m && req.method === "POST" && m[2] === "/cancel") {
      const s = cancelSession(m[1]);
      return s ? json(res, 200, s) : json(res, 404, { error: "not found" });
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 500, { error: String(err.message || err) });
  }
});

await recover(await reconcile());
await refill();
setInterval(() => { refill(); schedule(); }, 5000);
setInterval(() => sleepExpired(), 30_000);
server.listen(config.listen.port, config.listen.host, () =>
  console.log(`[orchestrator] listening on ${config.listen.host}:${config.listen.port}, pool size ${config.poolSize}`),
);
