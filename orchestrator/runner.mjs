import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { db, now, addEvent, updateSession, getSession, pendingMessages } from "./db.mjs";
import { config } from "./config.mjs";
import * as pool from "./pool.mjs";
import { mintSession, revokeSession, proxyUrl } from "./agentvault.mjs";
import * as git from "./git.mjs";

// A session is a conversation made of turns. Each message (the first prompt or a follow-up) is one turn.
//
//   queued -> starting -> running -> pushing -> idle      box parked, a follow-up resumes in it instantly
//                                                 |
//                             IDLE_TIMEOUT_MIN    v
//                                             sleeping    repo + Claude history saved on the host, box destroyed;
//                                                          a follow-up restores them into a fresh box
//   failed / cancelled: box destroyed, not resumable

const running = new Map(); // sessionId -> { child, cancelled }
const busy = new Set(); // sessions with a turn in flight (guards the scheduler)

const insertMessage = db.prepare("INSERT INTO session_messages (session_id, prompt, author, status, created_at) VALUES (?, ?, ?, 'pending', ?)");
const setMessage = (id, status) => db.prepare("UPDATE session_messages SET status = ? WHERE id = ?").run(status, id);

export function createSession({ prompt, repo, baseBranch, requestedBy, source }) {
  const id = `s-${randomBytes(4).toString("hex")}`;
  db.prepare(
    `INSERT INTO sessions (id, status, prompt, repo, base_branch, branch, requested_by, source, created_at)
     VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, prompt, git.normalizeRepo(repo), baseBranch || null, `agentbox/${id}`, requestedBy || "unknown", source || "api", now());
  insertMessage.run(id, prompt, requestedBy || "unknown", now());
  addEvent(id, "status", { status: "queued" });
  schedule();
  return getSession(id);
}

// Follow-up message. Queued if a turn is running, run right away if the session is idle or sleeping.
export function sendMessage(id, { prompt, author }) {
  const s = getSession(id);
  if (!s) return null;
  if (["failed", "cancelled"].includes(s.status)) throw new Error(`session is ${s.status}; start a new one`);
  const { lastInsertRowid } = insertMessage.run(id, prompt, author || "unknown", now());
  const ev = addEvent(id, "message", { id: Number(lastInsertRowid), prompt, author, queued: busy.has(id) });
  schedule();
  return { session: getSession(id), messageId: Number(lastInsertRowid), eventSeq: ev.seq };
}

// Decide what can run now. New sessions and sleeping sessions need a fresh box; idle ones already have one.
export function schedule() {
  const waiting = db
    .prepare(
      `SELECT DISTINCT s.* FROM sessions s JOIN session_messages m ON m.session_id = s.id AND m.status = 'pending'
       WHERE s.status IN ('queued', 'idle', 'sleeping') ORDER BY s.created_at`,
    )
    .all()
    .filter((s) => !busy.has(s.id));

  for (const s of waiting) {
    if (s.status === "idle") {
      const box = pool.boxForSession(s.id);
      if (box) { start(s.id, box, "warm"); continue; }
    }
    const box = pool.claimBox(s.id);
    if (!box) {
      // Full: make room by putting the longest-idle session to sleep, then try again on the next tick.
      if (pool.freshCount() === 0 && pool.totalCount() >= config.maxBoxes) {
        const victim = pool.oldestParked();
        if (victim) sleepSession(victim.session_id, "evicted to make room").then(() => pool.refill());
      }
      return;
    }
    start(s.id, box, s.status === "sleeping" ? "restore" : "new");
  }
}

// mode: "new" (fresh box, clone the repo) | "warm" (the session's parked box) | "restore" (fresh box, copy saved state in)
function start(id, box, mode) {
  busy.add(id);
  pool.markBusy(box.id);
  turnLoop(id, box, mode)
    .catch((err) => console.error(`[runner] ${id} crashed`, err))
    .finally(() => { busy.delete(id); schedule(); });
}

// Run every pending message for this session in its box, then park the box.
async function turnLoop(id, box, mode) {
  const log = (msg, extra = {}) => addEvent(id, "log", { msg, ...extra });
  try {
    updateSession(id, { status: "starting", box_id: box.id, ...(getSession(id).started_at ? {} : { started_at: now() }) });
    const s = getSession(id);
    const { workspace } = pool.slotPaths(box.slot_dir);

    if (mode === "new") {
      const base = await git.checkout(s.repo, workspace, s.branch, s.base_branch);
      updateSession(id, { base_branch: base });
      log(`claimed ${box.id} (${box.ip}), checked out ${s.repo}@${base} on ${s.branch}`, { tag: "box", mode, box: box.id, ip: box.ip, repo: s.repo, base, branch: s.branch });
    } else if (mode === "restore") {
      await pool.restoreState(box, id);
      log(`claimed ${box.id} (${box.ip}), restored repo and Claude history from ${pool.sessionStateDir(id)}`, { tag: "box", mode, box: box.id, ip: box.ip, repo: s.repo, branch: s.branch });
    } else {
      log(`resuming in parked box ${box.id} (${box.ip})`, { tag: "box", mode, box: box.id, ip: box.ip, repo: s.repo, branch: s.branch });
    }

    let msg;
    while ((msg = pendingMessages(id)[0])) {
      if (running.get(id)?.cancelled) break;
      setMessage(msg.id, "running");
      await runTurn(id, box, msg);
      setMessage(msg.id, "done");
    }
    if (running.get(id)?.cancelled) throw Object.assign(new Error("cancelled"), { cancelled: true });

    pool.parkBox(box.id);
    updateSession(id, { status: "idle", finished_at: now() });
    log(`box ${box.id} parked; follow-ups resume instantly for ${config.idleTimeoutMs / 60000} min`, { tag: "parked", box: box.id, idleMinutes: config.idleTimeoutMs / 60000 });
  } catch (err) {
    const cancelled = err.cancelled || running.get(id)?.cancelled;
    db.prepare("UPDATE session_messages SET status = 'failed' WHERE session_id = ? AND status IN ('pending', 'running')").run(id);
    updateSession(id, { status: cancelled ? "cancelled" : "failed", error: cancelled ? null : String(err.message || err), finished_at: now(), box_id: null });
    await pool.releaseBox(box.id);
  } finally {
    running.delete(id);
  }
}

// One turn: fresh Agent Vault session, run Claude (resuming its conversation if there is one), push, revoke.
async function runTurn(id, box, msg) {
  const log = (m, extra = {}) => addEvent(id, "log", { msg: m, ...extra });
  const s = getSession(id);
  const turn = db.prepare("SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ? AND status = 'done'").get(id).n + 1;
  const { workspace } = pool.slotPaths(box.slot_dir);
  const av = await mintSession();
  updateSession(id, { av_session_id: av.id });
  log(`turn ${turn}: minted Agent Vault session ${av.id} (bundle ${config.infisical.accessBundle}, expires ${av.expiresAt})`, { tag: "creds", action: "minted", turn, avSession: av.id, bundle: config.infisical.accessBundle, expiresAt: av.expiresAt });
  try {
    updateSession(id, { status: "running" });
    const result = await runAgent(id, box, msg.prompt, av.token, s.claude_session_id);
    if (running.get(id)?.cancelled) return;
    if (result?.is_error) throw new Error(`agent error: ${result.result || result.subtype}`);

    updateSession(id, { status: "pushing" });
    await git.commitAll(workspace, `agentbox ${id}: ${msg.prompt.slice(0, 60)}`);
    if (!(await git.hasChangesVsBase(workspace, s.base_branch))) return log("no changes yet", { tag: "nochanges" });
    if (await git.alreadyPushed(workspace, s.branch)) return log("no new changes this turn", { tag: "nochanges" });
    addEvent(id, "pr", { diffStat: await git.diffStat(workspace, s.base_branch) });
    if (!(await git.push(workspace, s.branch))) {
      return addEvent(id, "pr", { note: "no GITHUB_TOKEN configured; diff kept in events", diff: (await git.diff(workspace, s.base_branch)).slice(0, 200_000) });
    }
    if (getSession(id).pr_url) return addEvent(id, "pr", { url: getSession(id).pr_url, updated: true });
    const prUrl = await git.openPr({
      repo: s.repo, branch: s.branch, baseBranch: s.base_branch,
      title: `agentbox: ${s.prompt.slice(0, 70)}`,
      body: `Opened by agentbox session \`${id}\` for ${s.requested_by}.\n\n> ${s.prompt}\n\n${result?.result ? `**Agent summary**\n\n${result.result}` : ""}`,
    });
    updateSession(id, { pr_url: prUrl });
    addEvent(id, "pr", { url: prUrl });
  } finally {
    await revokeSession(av.id).then(() => log(`revoked Agent Vault session ${av.id}`, { tag: "creds", action: "revoked", turn, avSession: av.id })).catch((e) => log(`revoke failed: ${e.message}`));
  }
}

// Run Claude Code headless inside the box. Every event it prints becomes a session_event row.
function runAgent(id, box, prompt, avToken, resumeId) {
  const proxy = proxyUrl(avToken);
  const args = [
    "exec", "-i", "-u", "agent", "-w", "/workspace",
    "-e", `HTTPS_PROXY=${proxy}`, "-e", `HTTP_PROXY=${proxy}`,
    "-e", `ANTHROPIC_API_KEY=${config.anthropicPlaceholder}`,
    "-e", `AGENTBOX_SESSION=${id}`,
    box.container,
    "claude", "-p", prompt,
    ...(resumeId ? ["--resume", resumeId] : []),
    "--output-format", "stream-json", "--verbose",
    "--dangerously-skip-permissions",
    "--max-turns", String(config.maxTurns),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { env: { ...process.env, DOCKER_CONTEXT: config.docker.context }, stdio: ["ignore", "pipe", "pipe"] });
    const entry = { child, cancelled: false };
    running.set(id, entry);
    let result;
    const timer = setTimeout(() => {
      addEvent(id, "error", { msg: `timed out after ${config.sessionTimeoutMs / 60000} min` });
      child.kill("SIGKILL");
    }, config.sessionTimeoutMs);

    createInterface({ input: child.stdout }).on("line", (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return addEvent(id, "log", { stdout: line }); }
      if (ev.type === "system" && ev.subtype === "init") updateSession(id, { claude_session_id: ev.session_id });
      if (ev.type === "result") {
        result = ev;
        const prev = getSession(id);
        updateSession(id, {
          // Claude reports total_cost_usd cumulatively across a resumed conversation, so keep the max.
          cost_usd: Math.max(prev.cost_usd || 0, ev.total_cost_usd ?? 0),
          num_turns: (prev.num_turns || 0) + (ev.num_turns ?? 0),
          ...(ev.session_id ? { claude_session_id: ev.session_id } : {}),
        });
        addEvent(id, "result", ev);
      } else addEvent(id, "agent", ev);
    });
    createInterface({ input: child.stderr }).on("line", (line) => addEvent(id, "log", { stderr: line }));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (entry.cancelled) return resolve(null);
      if (code !== 0 && !result) return reject(new Error(`agent exited with code ${code}`));
      resolve(result);
    });
  });
}

// Save an idle session's repo and Claude history to the host, then destroy its box.
export async function sleepSession(id, reason) {
  const box = pool.boxForSession(id);
  if (!box || busy.has(id)) return;
  busy.add(id);
  try {
    await pool.saveState(box, id);
    updateSession(id, { status: "sleeping", box_id: null });
    addEvent(id, "log", { msg: `${reason}: state saved to ${pool.sessionStateDir(id)}, box ${box.id} destroyed` });
    await pool.releaseBox(box.id);
  } catch (err) {
    addEvent(id, "error", { msg: `sleep failed: ${err.message}` });
  } finally {
    busy.delete(id);
  }
}

export async function sleepExpired() {
  for (const box of pool.expiredParked(config.idleTimeoutMs)) await sleepSession(box.session_id, `idle for ${config.idleTimeoutMs / 60000} min`);
}

export function cancelSession(id) {
  const s = getSession(id);
  if (!s) return null;
  const r = running.get(id);
  if (r) {
    r.cancelled = true;
    r.child.kill("SIGKILL");
  } else if (["queued", "idle", "sleeping"].includes(s.status)) {
    db.prepare("UPDATE session_messages SET status = 'failed' WHERE session_id = ? AND status = 'pending'").run(id);
    const box = pool.boxForSession(id);
    updateSession(id, { status: "cancelled", finished_at: now(), box_id: null });
    if (box) pool.releaseBox(box.id);
  }
  return getSession(id);
}

// On boot: sessions that were mid-turn can't be continued (the exec died with the process). Parked sessions are
// put to sleep properly so a follow-up can still restore them.
export async function recover(parkedBoxes) {
  for (const s of db.prepare("SELECT id, av_session_id FROM sessions WHERE status IN ('starting', 'running', 'pushing')").all()) {
    db.prepare("UPDATE session_messages SET status = 'failed' WHERE session_id = ? AND status IN ('pending', 'running')").run(s.id);
    updateSession(s.id, { status: "failed", error: "orchestrator restarted mid-session", finished_at: now(), box_id: null });
    if (s.av_session_id) await revokeSession(s.av_session_id).catch(() => {});
  }
  for (const box of parkedBoxes) await sleepSession(box.session_id, "orchestrator restarted");
}
