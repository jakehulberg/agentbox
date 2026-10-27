// boxd: the sandbox droplet's box API. The Session Durable Object calls it to create boxes and run commands in them.
// It never sees a real credential: the only secret that passes through is a short-lived Agent Vault session token,
// inside HTTPS_PROXY, for one command.
//
//   POST   /boxes                {session}            create a box (container) for a session
//   POST   /boxes/:name/start | /stop                 wake / sleep (the container's disk is kept while stopped)
//   DELETE /boxes/:name                               destroy
//   POST   /boxes/:name/exec     {cmd, env, timeoutSec} start a command as user agent; returns {execId}
//   GET    /execs/:id?after=N                         output lines from N on, plus {done, exitCode}
//   POST   /execs/:id/kill
//   GET    /boxes                                     list
//   GET    /healthz
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";

const run = promisify(execFile);
const docker = (...args) => run("docker", args, { maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout.trim());

const PORT = Number(process.env.PORT || 8788);
const TOKEN = process.env.BOXD_TOKEN || "";
const IMAGE = process.env.BOX_IMAGE || "agentbox/infisical2:latest";
const NETWORK = process.env.BOX_NETWORK || "agentnet";
const CPUS = process.env.BOX_CPUS || "2";
const MEMORY = process.env.BOX_MEMORY || "3g";
const MAX_BOXES = Number(process.env.MAX_BOXES || 3); // running boxes at once; stopped ones don't count
const EXEC_DIR = process.env.EXEC_DIR || "/var/lib/agentbox/execs";
const LABEL = "org.agentbox.session";
if (!TOKEN) throw new Error("BOXD_TOKEN is required");
mkdirSync(EXEC_DIR, { recursive: true });

const children = new Map(); // execId -> child process
const nameOk = (n) => /^agentbox-s-[a-f0-9]{8}$/.test(n);
const execOk = (id) => /^x-[a-f0-9]{12}$/.test(id);
const logPath = (id) => `${EXEC_DIR}/${id}.log`;
const exitPath = (id) => `${EXEC_DIR}/${id}.exit`;

function authed(req) {
  const got = Buffer.from((req.headers.authorization || "").replace(/^Bearer /, ""));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function runningCount() {
  const out = await docker("ps", "-q", "--filter", `label=${LABEL}`);
  return out ? out.split("\n").length : 0;
}

async function boxInfo(name) {
  const out = await docker("inspect", "-f", `{{.State.Status}} {{(index .NetworkSettings.Networks "${NETWORK}").IPAddress}}`, name).catch(() => "");
  if (!out) return null;
  const [state, ip] = out.split(" ");
  return { name, state, ip: ip || null };
}

async function createBox(session) {
  if (!/^s-[a-f0-9]{8}$/.test(session || "")) throw httpError(400, "bad session id");
  const name = `agentbox-${session}`;
  const existing = await boxInfo(name);
  if (existing) return existing;
  if ((await runningCount()) >= MAX_BOXES) throw httpError(429, `all ${MAX_BOXES} boxes are busy`);
  await docker(
    "run", "-d", "--name", name, "--hostname", session, "--label", `${LABEL}=${session}`,
    "--network", NETWORK, "--cpus", CPUS, "--memory", MEMORY, "--pids-limit", "4096",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", IMAGE,
  );
  return boxInfo(name);
}

async function startBox(name) {
  const info = await boxInfo(name);
  if (!info) throw httpError(404, "no such box");
  if (info.state !== "running") {
    if ((await runningCount()) >= MAX_BOXES) throw httpError(429, `all ${MAX_BOXES} boxes are busy`);
    await docker("start", name);
  }
  return boxInfo(name);
}

// Runs `cmd` in the box as user agent. Every output line is appended to a file as {s: "o"|"e", l: line},
// so the DO can read from any offset, even after it was evicted and woke up again.
async function startExec(name, { cmd, env = {}, timeoutSec = 1800 }) {
  if (!Array.isArray(cmd) || !cmd.length) throw httpError(400, "cmd must be a non-empty array");
  const info = await boxInfo(name);
  if (!info || info.state !== "running") throw httpError(409, "box is not running");
  const id = `x-${randomBytes(6).toString("hex")}`;
  writeFileSync(logPath(id), "");
  const args = ["exec", "-i", "-u", "agent", "-w", "/workspace"];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  const child = spawn("docker", [...args, name, ...cmd], { stdio: ["ignore", "pipe", "pipe"] });
  children.set(id, child);
  const pipe = (stream, s) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        appendFileSync(logPath(id), JSON.stringify({ s, l: buf.slice(0, i) }) + "\n");
        buf = buf.slice(i + 1);
      }
    });
    stream.on("end", () => { if (buf) appendFileSync(logPath(id), JSON.stringify({ s, l: buf }) + "\n"); });
  };
  pipe(child.stdout, "o");
  pipe(child.stderr, "e");
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutSec * 1000);
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    children.delete(id);
    // give the stream "end" handlers a moment to flush their last partial line
    setTimeout(() => writeFileSync(exitPath(id), JSON.stringify({ code, signal })), 50);
  });
  return { execId: id };
}

function readExec(id, after) {
  if (!existsSync(logPath(id))) throw httpError(404, "no such exec");
  const lines = readFileSync(logPath(id), "utf8").split("\n").filter(Boolean);
  const from = Math.max(0, after);
  const slice = lines.slice(from, from + 500).map((l) => JSON.parse(l));
  const exit = existsSync(exitPath(id)) ? JSON.parse(readFileSync(exitPath(id), "utf8")) : null;
  const done = !!exit && from + slice.length >= lines.length;
  return { lines: slice, next: from + slice.length, done, exitCode: done ? exit.code : null, signal: done ? exit.signal : null };
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

async function route(req, url, body) {
  const p = url.pathname.split("/").filter(Boolean);
  const m = req.method;
  if (m === "GET" && url.pathname === "/healthz") return { ok: true };
  if (m === "GET" && url.pathname === "/boxes") {
    const out = await docker("ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{.Names}} {{.State}}");
    return out ? out.split("\n").map((l) => ({ name: l.split(" ")[0], state: l.split(" ")[1] })) : [];
  }
  if (m === "POST" && url.pathname === "/boxes") return createBox(body.session);
  if (p[0] === "boxes" && p[1]) {
    const name = p[1];
    if (!nameOk(name)) throw httpError(400, "bad box name");
    if (m === "DELETE" && p.length === 2) { await docker("rm", "-f", name).catch(() => {}); return { deleted: name }; }
    if (m === "POST" && p[2] === "start") return startBox(name);
    if (m === "POST" && p[2] === "stop") { await docker("stop", "-t", "5", name); return boxInfo(name); }
    if (m === "POST" && p[2] === "exec") return startExec(name, body);
  }
  if (p[0] === "execs" && p[1]) {
    if (!execOk(p[1])) throw httpError(400, "bad exec id");
    if (m === "GET") return readExec(p[1], Number(url.searchParams.get("after") || 0));
    if (m === "POST" && p[2] === "kill") { children.get(p[1])?.kill("SIGKILL"); return { killed: p[1] }; }
  }
  throw httpError(404, "not found");
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://boxd");
  const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (url.pathname !== "/healthz" && !authed(req)) return send(401, { error: "unauthorized" });
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    const body = raw ? JSON.parse(raw) : {};
    send(200, await route(req, url, body));
  } catch (err) {
    console.error(`[boxd] ${req.method} ${url.pathname}:`, err.stderr || err.message);
    send(err.status || 500, { error: err.status ? err.message : String(err.stderr || err.message).slice(0, 500) });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`[boxd] listening on 127.0.0.1:${PORT}, image ${IMAGE}`));
