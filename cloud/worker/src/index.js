// agentbox API: a stateless Worker in front of one Session Durable Object per session.
//
// The Worker verifies the caller (GitHub device login -> agentbox JWT) and routes to the session's DO.
// The DO runs every turn: create or wake a box on the sandbox droplet (boxd), mint an Agent Vault grant,
// run Claude, pull its output into SQLite and out to WebSockets, then run finish.sh under a second grant
// to push and open the PR. Everything is driven by the DO's alarm, so an eviction never loses a turn.
import { DurableObject } from "cloudflare:workers";
import { FINISH_SH } from "./finish.js";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const fail = (status, error) => json({ error }, status);
const nowIso = () => new Date().toISOString();
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

// ---------------------------------------------------------------- JWT (HS256)
const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (obj) => b64url(enc.encode(JSON.stringify(obj)));
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const hmacKey = (secret) => crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

async function signJwt(payload, secret) {
  const head = `${b64urlJson({ alg: "HS256", typ: "JWT" })}.${b64urlJson(payload)}`;
  return `${head}.${b64url(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(head)))}`;
}

async function verifyJwt(token, secret) {
  const [h, p, sig] = (token || "").split(".");
  if (!sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(sig), enc.encode(`${h}.${p}`));
  if (!ok) return null;
  const payload = JSON.parse(new TextDecoder().decode(fromB64url(p)));
  return payload.exp > Date.now() / 1000 ? payload : null;
}

// ---------------------------------------------------------------- GitHub device login
async function deviceStart(env) {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_OAUTH_CLIENT_ID, scope: "read:user" }),
  });
  const out = await res.json();
  if (!out.device_code) return fail(502, out.error_description || "GitHub device flow failed");
  return json({ device_code: out.device_code, user_code: out.user_code, verification_uri: out.verification_uri, interval: out.interval, expires_in: out.expires_in });
}

async function deviceToken(env, { device_code }) {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_OAUTH_CLIENT_ID, device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
  });
  const out = await res.json();
  if (out.error === "authorization_pending" || out.error === "slow_down") return json({ pending: true, interval: out.interval });
  if (!out.access_token) return fail(400, out.error_description || out.error || "login failed");
  // Used once to learn who this is, then dropped. The CLI only ever holds the agentbox JWT.
  const user = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${out.access_token}`, "user-agent": "agentbox" } }).then((r) => r.json());
  const allowed = env.ALLOWED_LOGINS.split(",").map((s) => s.trim().toLowerCase());
  if (!user.login || !allowed.includes(user.login.toLowerCase())) return fail(403, `${user.login || "this account"} isn't allowed to use agentbox`);
  const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
  return json({ token: await signJwt({ sub: user.login, exp }, env.JWT_SECRET), login: user.login, expiresAt: new Date(exp * 1000).toISOString() });
}

// ---------------------------------------------------------------- the Worker
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname.split("/").filter(Boolean);
    const m = request.method;
    try {
      if (url.pathname === "/healthz") return json({ ok: true });
      if (m === "POST" && url.pathname === "/auth/device") return deviceStart(env);
      if (m === "POST" && url.pathname === "/auth/token") return deviceToken(env, await request.json());

      const bearer = (request.headers.get("authorization") || "").replace(/^Bearer /, "") || url.searchParams.get("access_token");
      const claims = await verifyJwt(bearer, env.JWT_SECRET);
      if (!claims) return fail(401, "not logged in: run agentbox login");
      const login = claims.sub;

      if (p[0] !== "sessions") return fail(404, "not found");

      if (m === "GET" && p.length === 1) {
        const { results } = await env.DB.prepare("SELECT * FROM sessions_index WHERE owner = ? ORDER BY updated_at DESC LIMIT 50").bind(login).all();
        return json(results);
      }

      if (m === "POST" && p.length === 1) {
        const body = await request.json();
        const repo = body.repo || env.DEFAULT_REPO;
        if (repo !== env.DEFAULT_REPO) return fail(400, `only ${env.DEFAULT_REPO} has a snapshot on this platform`);
        if (!body.prompt?.trim()) return fail(400, "prompt is required");
        const id = `s-${hex(4)}`;
        const t = nowIso();
        await env.DB.prepare("INSERT INTO sessions_index (id, owner, repo, prompt, status, cost_usd, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)")
          .bind(id, login, repo, body.prompt.trim(), t, t).run();
        const stub = env.SESSION.get(env.SESSION.idFromName(id));
        return json(await stub.start({ id, owner: login, repo, base: env.BASE_BRANCH, prompt: body.prompt.trim() }));
      }

      // everything below is about one session, which must belong to the caller
      const id = p[1];
      const row = await env.DB.prepare("SELECT owner FROM sessions_index WHERE id = ?").bind(id).first();
      if (!row || row.owner !== login) return fail(404, "no such session");
      const stub = env.SESSION.get(env.SESSION.idFromName(id));

      if (m === "GET" && p.length === 2) return json(await stub.state());
      if (m === "GET" && p[2] === "stream") return stub.fetch(request);
      if (m === "POST" && p[2] === "messages") {
        const body = await request.json();
        if (!body.prompt?.trim()) return fail(400, "prompt is required");
        return json(await stub.message({ prompt: body.prompt.trim(), author: login }));
      }
      if (m === "POST" && p[2] === "cancel") return json(await stub.cancel());
      return fail(404, "not found");
    } catch (err) {
      return fail(err.status || 500, err.message || String(err));
    }
  },
};

// ---------------------------------------------------------------- one Durable Object per session
const TICK_MS = 1000;
const TURN_TIMEOUT_MS = 30 * 60 * 1000;
const SETTLED = ["idle", "sleeping", "failed", "cancelled"];

export class SessionDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT, author TEXT, status TEXT, created_at TEXT);
      CREATE TABLE IF NOT EXISTS turns (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER, phase TEXT, exec_id TEXT,
        log_next INTEGER DEFAULT 0, av_session_id TEXT, av_finish_session_id TEXT, started_at TEXT, ended_at TEXT, result TEXT);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, kind TEXT, data TEXT);
    `);
    this.infisical = { token: null, exp: 0 };
  }

  // ---------- storage helpers
  s() {
    const row = this.sql.exec("SELECT data FROM session LIMIT 1").toArray()[0];
    return row ? JSON.parse(row.data) : null;
  }
  async save(patch) {
    const next = { ...this.s(), ...patch, updated_at: nowIso() };
    this.sql.exec("INSERT OR REPLACE INTO session (id, data) VALUES (?, ?)", next.id, JSON.stringify(next));
    await this.env.DB.prepare("UPDATE sessions_index SET status = ?, pr_url = ?, cost_usd = ?, updated_at = ? WHERE id = ?")
      .bind(next.status, next.pr_url || null, next.cost_usd || 0, next.updated_at, next.id).run();
    return next;
  }
  event(kind, data) {
    const ts = nowIso();
    const { seq } = this.sql.exec("INSERT INTO events (ts, kind, data) VALUES (?, ?, ?) RETURNING seq", ts, kind, JSON.stringify(data)).one();
    const frame = JSON.stringify({ seq, ts, kind, data });
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(frame); } catch {} }
    return seq;
  }
  log(msg, extra = {}) { return this.event("log", { msg, ...extra }); }
  pending() { return this.sql.exec("SELECT * FROM messages WHERE status = 'pending' ORDER BY id LIMIT 1").toArray()[0]; }
  currentTurn() { return this.sql.exec("SELECT * FROM turns WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1").toArray()[0]; }
  setMessage(id, status) { this.sql.exec("UPDATE messages SET status = ? WHERE id = ?", status, id); }
  async setStatus(status, extra = {}) {
    await this.save({ status, ...extra });
    this.event("status", { status, ...(extra.error ? { error: extra.error } : {}) });
    if (SETTLED.includes(status) && !this.pending()) for (const ws of this.ctx.getWebSockets()) { try { ws.close(1000, status); } catch {} }
  }
  wake(ms = 0) { return this.ctx.storage.setAlarm(Date.now() + ms); }

  // ---------- outside services
  async boxd(method, path, body) {
    const res = await fetch(this.env.BOXD_URL + path, {
      method,
      headers: {
        authorization: `Bearer ${this.env.BOXD_TOKEN}`,
        "content-type": "application/json",
        // Cloudflare Access in front of the tunnel: without these, the request never reaches the droplet
        "cf-access-client-id": this.env.CF_ACCESS_CLIENT_ID,
        "cf-access-client-secret": this.env.CF_ACCESS_CLIENT_SECRET,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`boxd ${method} ${path}: ${out.error || res.status}`), { status: res.status });
    return out;
  }
  async infisicalToken() {
    if (this.infisical.token && Date.now() < this.infisical.exp - 60_000) return this.infisical.token;
    const res = await fetch(`${this.env.INFISICAL_URL}/api/v1/auth/universal-auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: this.env.INFISICAL_CLIENT_ID, clientSecret: this.env.INFISICAL_CLIENT_SECRET }),
    });
    if (!res.ok) throw new Error(`Infisical login failed: ${res.status}`);
    const out = await res.json();
    this.infisical = { token: out.accessToken, exp: Date.now() + out.expiresIn * 1000 };
    return out.accessToken;
  }
  async av(method, path, body) {
    const res = await fetch(`${this.env.INFISICAL_URL}/api/v1/agent-vault${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.infisicalToken()}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Agent Vault ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  async mint(bundle, ttl) {
    const { session } = await this.av("POST", "/sessions", { accessBundles: [bundle], ttl });
    return session;
  }
  async revoke(avId, turn) {
    if (!avId) return;
    await this.av("POST", `/sessions/${avId}/revoke`)
      .then(() => this.log(`revoked Agent Vault session ${avId}`, { tag: "creds", action: "revoked", turn, avSession: avId }))
      .catch((e) => this.log(`revoke failed: ${e.message}`));
  }
  proxyEnv(token) {
    const proxy = `http://x-agent-vault:${encodeURIComponent(token)}@${this.env.PROXY_ADDR}`;
    return { HTTPS_PROXY: proxy, HTTP_PROXY: proxy };
  }
  // A short command in the box, waited on here (setup and cleanup steps only).
  async execSync(box, cmd, env = {}, timeoutMs = 60_000) {
    const { execId } = await this.boxd("POST", `/boxes/${box}/exec`, { cmd, env, timeoutSec: Math.ceil(timeoutMs / 1000) });
    const until = Date.now() + timeoutMs;
    let lines = [];
    for (let after = 0; Date.now() < until;) {
      const r = await this.boxd("GET", `/execs/${execId}?after=${after}`);
      lines = lines.concat(r.lines);
      after = r.next;
      if (r.done) return { code: r.exitCode, lines };
      await new Promise((ok) => setTimeout(ok, 500));
    }
    throw new Error(`${cmd[0]} timed out`);
  }

  // ---------- RPC from the Worker
  async start({ id, owner, repo, base, prompt }) {
    if (this.s()) return this.s();
    this.sql.exec("INSERT INTO session (id, data) VALUES (?, ?)", id, JSON.stringify({ id }));
    await this.save({ id, owner, repo, base_branch: base, branch: `agentbox/${id}`, prompt, status: "queued", created_at: nowIso(), cost_usd: 0, num_turns: 0 });
    this.sql.exec("INSERT INTO messages (prompt, author, status, created_at) VALUES (?, ?, 'pending', ?)", prompt, owner, nowIso());
    this.event("status", { status: "queued" });
    await this.wake();
    return this.s();
  }

  async message({ prompt, author }) {
    const s = this.s();
    if (["failed", "cancelled"].includes(s.status)) throw Object.assign(new Error(`session is ${s.status}; start a new one`), { status: 409 });
    const { id } = this.sql.exec("INSERT INTO messages (prompt, author, status, created_at) VALUES (?, ?, 'pending', ?) RETURNING id", prompt, author, nowIso()).one();
    const eventSeq = this.event("message", { id, prompt, author, queued: !SETTLED.includes(s.status) });
    if (SETTLED.includes(s.status)) await this.wake();
    return { session: this.s(), messageId: id, eventSeq };
  }

  state() { return this.s(); }

  async cancel() {
    const s = this.s();
    if (["failed", "cancelled"].includes(s.status)) return s;
    const turn = this.currentTurn();
    if (turn?.exec_id) await this.boxd("POST", `/execs/${turn.exec_id}/kill`).catch(() => {});
    if (turn) {
      await this.revoke(turn.av_session_id);
      await this.revoke(turn.av_finish_session_id);
      this.sql.exec("UPDATE turns SET ended_at = ?, result = 'cancelled' WHERE id = ?", nowIso(), turn.id);
    }
    this.sql.exec("UPDATE messages SET status = 'failed' WHERE status IN ('pending', 'running')");
    if (s.box) await this.boxd("DELETE", `/boxes/${s.box}`).catch(() => {});
    await this.setStatus("cancelled", { box: null, finished_at: nowIso() });
    await this.ctx.storage.deleteAlarm();
    return this.s();
  }

  // ---------- WebSocket stream: replay after ?after=<seq>, then live
  async fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") return fail(426, "expected a WebSocket");
    const after = Number(new URL(request.url).searchParams.get("after") || 0);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const last = this.sql.exec("SELECT COALESCE(MAX(seq), 0) AS n FROM events").one().n;
    for (const ev of this.sql.exec("SELECT * FROM events WHERE seq > ? ORDER BY seq", Math.min(after, last)).toArray())
      server.send(JSON.stringify({ seq: ev.seq, ts: ev.ts, kind: ev.kind, data: JSON.parse(ev.data) }));
    if (SETTLED.includes(this.s().status) && !this.pending()) server.close(1000, this.s().status);
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage() {}
  webSocketClose(ws, code) { try { ws.close(code); } catch {} }

  // ---------- the engine: every step happens in the alarm
  async alarm() {
    try {
      await this.tick();
    } catch (err) {
      // A failed step fails this turn, not the session: revoke its grants and go idle so the user can retry.
      const s = this.s();
      if (["starting", "running", "finishing"].includes(s.status)) {
        const turn = this.currentTurn();
        if (turn) {
          if (turn.exec_id) await this.boxd("POST", `/execs/${turn.exec_id}/kill`).catch(() => {});
          await this.revoke(turn.av_session_id);
          await this.revoke(turn.av_finish_session_id);
          await this.endTurn(turn, "failed", err.message).catch(() => {});
        } else {
          this.sql.exec("UPDATE messages SET status = 'failed' WHERE status = 'running'");
          this.event("error", { msg: err.message });
          await this.setStatus(s.box ? "idle" : "failed", { idle_since: nowIso(), error: err.message });
        }
      } else this.event("error", { msg: err.message });
    }
    const s = this.s();
    if (["starting", "running", "finishing"].includes(s.status)) await this.wake(TICK_MS);
    else if (["queued", "idle", "sleeping"].includes(s.status) && this.pending())
      await this.wake(s.retry_at ? Math.max(0, Date.parse(s.retry_at) - Date.now()) : 0);
    else if (s.status === "idle") await this.wake(Math.max(0, Date.parse(s.idle_since) + this.idleMs() - Date.now()));
  }
  idleMs() { return Number(this.env.IDLE_MINUTES || 15) * 60_000; }

  async tick() {
    const s = this.s();
    if (!s) return;
    if (["queued", "idle", "sleeping"].includes(s.status)) {
      if (this.pending()) {
        if (s.retry_at && Date.now() < Date.parse(s.retry_at)) return;
        return this.startTurn();
      }
      if (s.status === "idle" && Date.now() >= Date.parse(s.idle_since) + this.idleMs()) return this.sleep();
      return;
    }
    const turn = this.currentTurn();
    if (!turn) return;
    if (s.status === "running") return this.pollAgent(turn);
    if (s.status === "finishing") return this.pollFinish(turn);
    if (s.status === "starting") throw new Error("interrupted while starting the turn");
  }

  async startTurn() {
    const s = this.s();
    const msg = this.pending();
    const from = s.status;
    const turnNo = this.sql.exec("SELECT COUNT(*) AS n FROM turns").one().n + 1;
    this.setMessage(msg.id, "running");
    await this.setStatus("starting", { retry_at: null, ...(s.started_at ? {} : { started_at: nowIso() }) });
    let box = s.box;
    try {
      if (!box) {
        const b = await this.boxd("POST", "/boxes", { session: s.id });
        box = b.name;
        await this.save({ box, ip: b.ip });
        const r = await this.execSync(box, ["git", "checkout", "-q", "-b", s.branch, `origin/${s.base_branch}`]);
        if (r.code !== 0) throw new Error(`checkout failed: ${r.lines.map((l) => l.l).join(" ").slice(0, 300)}`);
        this.log(`box ${box} (${b.ip}) from the ${s.repo} snapshot, on ${s.branch}`, { tag: "box", mode: "new", box, ip: b.ip, repo: s.repo, branch: s.branch });
      } else if (from === "sleeping") {
        const b = await this.boxd("POST", `/boxes/${box}/start`);
        await this.save({ ip: b.ip });
        this.log(`woke ${box} (${b.ip})`, { tag: "box", mode: "restore", box, ip: b.ip, repo: s.repo, branch: s.branch });
      } else {
        this.log(`resuming in ${box}`, { tag: "box", mode: "warm", box, ip: s.ip, repo: s.repo, branch: s.branch });
      }
    } catch (err) {
      if (err.status !== 429) throw err;
      // droplet full: put the message back and try again shortly
      this.setMessage(msg.id, "pending");
      await this.save({ status: from, retry_at: new Date(Date.now() + 15_000).toISOString() });
      this.log("all boxes busy; waiting for one", { tag: "waiting" });
      return;
    }

    const grant = await this.mint(this.env.AGENT_BUNDLE, "45m");
    const { id: turnId } = this.sql.exec("INSERT INTO turns (message_id, phase, av_session_id, started_at) VALUES (?, 'agent', ?, ?) RETURNING id", msg.id, grant.id, nowIso()).one();
    this.log(`turn ${turnNo}: minted Agent Vault session ${grant.id} (bundle ${this.env.AGENT_BUNDLE})`, { tag: "creds", action: "minted", turn: turnNo, avSession: grant.id, bundle: this.env.AGENT_BUNDLE });
    const cmd = ["claude", "-p", msg.prompt, ...(s.claude_session_id ? ["--resume", s.claude_session_id] : []),
      "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--max-turns", "40"];
    const { execId } = await this.boxd("POST", `/boxes/${box}/exec`, {
      cmd, env: { ...this.proxyEnv(grant.token), ANTHROPIC_API_KEY: "placeholder", AGENTBOX_SESSION: s.id }, timeoutSec: TURN_TIMEOUT_MS / 1000,
    });
    this.sql.exec("UPDATE turns SET exec_id = ? WHERE id = ?", execId, turnId);
    await this.setStatus("running");
  }

  // Pull new output lines from the running command. Safe to repeat: log_next is the cursor.
  async readLines(turn, onLine) {
    const r = await this.boxd("GET", `/execs/${turn.exec_id}?after=${turn.log_next}`);
    for (const line of r.lines) await onLine(line);
    this.sql.exec("UPDATE turns SET log_next = ? WHERE id = ?", r.next, turn.id);
    return r;
  }

  async pollAgent(turn) {
    let result = turn.result ? JSON.parse(turn.result) : null;
    const r = await this.readLines(turn, async ({ s: stream, l }) => {
      if (stream === "e") return this.log(null, { stderr: l });
      let ev;
      try { ev = JSON.parse(l); } catch { return this.log(null, { stdout: l }); }
      if (ev.type === "system" && ev.subtype === "init") await this.save({ claude_session_id: ev.session_id });
      if (ev.type === "result") {
        result = ev;
        const prev = this.s();
        this.sql.exec("UPDATE turns SET result = ? WHERE id = ?", JSON.stringify(ev), turn.id);
        // Claude reports total_cost_usd cumulatively across a resumed conversation, so keep the max.
        await this.save({ cost_usd: Math.max(prev.cost_usd || 0, ev.total_cost_usd ?? 0), num_turns: (prev.num_turns || 0) + (ev.num_turns ?? 0), ...(ev.session_id ? { claude_session_id: ev.session_id } : {}) });
        this.event("result", ev);
      } else this.event("agent", ev);
    });
    if (!r.done) {
      if (Date.now() - Date.parse(turn.started_at) > TURN_TIMEOUT_MS) {
        await this.boxd("POST", `/execs/${turn.exec_id}/kill`).catch(() => {});
        this.event("error", { msg: `timed out after ${TURN_TIMEOUT_MS / 60000} min` });
      }
      return;
    }
    await this.revoke(turn.av_session_id, turn.id);
    if (r.exitCode !== 0 && !result) return this.endTurn(turn, "failed", `agent exited with code ${r.exitCode}`);
    if (result?.is_error) return this.endTurn(turn, "failed", `agent error: ${result.result || result.subtype}`);
    return this.startFinish(turn, result);
  }

  // After Claude exits: kill anything it left running, then push and open the PR under a separate grant.
  async startFinish(turn, result) {
    const s = this.s();
    await this.setStatus("finishing");
    await this.execSync(s.box, ["pkill", "-9", "-u", "agent"]).catch(() => {});
    const grant = await this.mint(this.env.FINISH_BUNDLE, "5m");
    this.log(`minted Agent Vault session ${grant.id} (bundle ${this.env.FINISH_BUNDLE}) for push + PR`, { tag: "creds", action: "minted", avSession: grant.id, bundle: this.env.FINISH_BUNDLE });
    const msg = this.sql.exec("SELECT prompt FROM messages WHERE id = ?", turn.message_id).one();
    const { execId } = await this.boxd("POST", `/boxes/${s.box}/exec`, {
      cmd: ["bash", "-c", FINISH_SH],
      env: {
        ...this.proxyEnv(grant.token),
        SESSION: s.id, BRANCH: s.branch, BASE: s.base_branch, REPO: s.repo, PR_URL: s.pr_url || "",
        MSG: msg.prompt.replace(/\s+/g, " ").slice(0, 60),
        TITLE: `agentbox: ${s.prompt.replace(/\s+/g, " ").slice(0, 70)}`,
        PRBODY: `Opened by agentbox session \`${s.id}\` for @${s.owner}.\n\n> ${s.prompt}\n\n${result?.result ? `**Agent summary**\n\n${result.result}` : ""}`,
      },
      timeoutSec: 300,
    });
    this.sql.exec("UPDATE turns SET phase = 'finish', exec_id = ?, log_next = 0, av_finish_session_id = ? WHERE id = ?", execId, grant.id, turn.id);
  }

  async pollFinish(turn) {
    let lastErr = "";
    const r = await this.readLines(turn, async ({ s: stream, l }) => {
      if (stream === "e") { lastErr = l; return this.log(null, { stderr: l }); }
      let out;
      try { out = JSON.parse(l); } catch { return this.log(null, { stdout: l }); }
      if (out.agentbox === "nochanges") this.log("no code changes", { tag: "nochanges" });
      else if (out.agentbox === "nonew") this.log("no new changes this turn", { tag: "nochanges" });
      else if (out.agentbox === "diffstat") this.event("pr", { diffStat: out.stat });
      else if (out.agentbox === "pr") {
        if (!out.updated) await this.save({ pr_url: out.url });
        this.event("pr", { url: out.url, updated: !!out.updated });
      }
    });
    if (!r.done) return;
    await this.revoke(turn.av_finish_session_id, turn.id);
    if (r.exitCode !== 0) this.event("error", { msg: `push / PR step failed: ${lastErr || `exit ${r.exitCode}`}` });
    return this.endTurn(turn, "done");
  }

  async endTurn(turn, msgStatus, error) {
    this.sql.exec("UPDATE turns SET ended_at = ? WHERE id = ?", nowIso(), turn.id);
    this.setMessage(turn.message_id, msgStatus);
    if (error) this.event("error", { msg: error });
    if (this.pending()) return this.startTurn();
    await this.setStatus("idle", { idle_since: nowIso(), finished_at: nowIso() });
    this.log(`box parked; follow-ups resume instantly for ${this.idleMs() / 60000} min`, { tag: "parked", idleMinutes: this.idleMs() / 60000 });
  }

  // Idle too long: stop the container. Its disk (repo, commits, Claude history) is kept for the next message.
  async sleep() {
    const s = this.s();
    if (s.box) await this.boxd("POST", `/boxes/${s.box}/stop`).catch((e) => this.log(`stop failed: ${e.message}`));
    await this.setStatus("sleeping");
    this.log(`idle for ${this.idleMs() / 60000} min: ${s.box} stopped, disk kept`);
  }
}
