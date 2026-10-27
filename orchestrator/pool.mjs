import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { db, now } from "./db.mjs";
import { config } from "./config.mjs";

const run = promisify(execFile);
const dockerEnv = { ...process.env, DOCKER_CONTEXT: config.docker.context };
export const docker = (...args) =>
  run("docker", args, { env: dockerEnv, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout.trim());

const LABEL = "org.agentbox.box";

// Each box's slot dir has two host folders mounted into it:
//   <slot>/workspace -> /workspace          (the repo)
//   <slot>/claude    -> /home/agent/.claude (Claude Code's conversation history, needed to resume)
export const slotPaths = (slotDir) => ({ workspace: join(slotDir, "workspace"), claude: join(slotDir, "claude") });
// Where a sleeping session's state lives once its box is gone.
export const sessionStateDir = (sessionId) => join(config.sessionsDir, sessionId);

async function createBox() {
  const id = `box-${randomBytes(3).toString("hex")}`;
  const container = `agentbox-${id}`;
  const slotDir = join(config.slotsDir, id);
  const { workspace, claude } = slotPaths(slotDir);
  mkdirSync(workspace, { recursive: true });
  mkdirSync(claude, { recursive: true });
  db.prepare("INSERT INTO boxes (id, container, slot_dir, status, created_at) VALUES (?, ?, ?, 'warming', ?)").run(
    id, container, slotDir, now(),
  );
  try {
    await docker(
      "run", "-d", "--name", container, "--hostname", id,
      "--label", `${LABEL}=${id}`,
      "--network", config.docker.network,
      "--cpus", config.docker.cpus, "--memory", config.docker.memory, "--pids-limit", "1024",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "-v", `${workspace}:/workspace`,
      "-v", `${claude}:/home/agent/.claude`,
      config.docker.image,
    );
    const ip = await docker("inspect", "-f", `{{(index .NetworkSettings.Networks "${config.docker.network}").IPAddress}}`, container);
    db.prepare("UPDATE boxes SET status = 'idle', ip = ? WHERE id = ?").run(ip, id);
    console.log(`[pool] ${id} idle at ${ip}`);
  } catch (err) {
    console.error(`[pool] failed to start ${id}:`, err.stderr || err.message);
    await destroyBox(id);
  }
}

export async function destroyBox(id) {
  const box = db.prepare("SELECT * FROM boxes WHERE id = ?").get(id);
  if (!box) return;
  await docker("rm", "-f", box.container).catch(() => {});
  rmSync(box.slot_dir, { recursive: true, force: true });
  db.prepare("DELETE FROM boxes WHERE id = ?").run(id);
  console.log(`[pool] ${id} destroyed`);
}

const count = (where) => db.prepare(`SELECT COUNT(*) AS n FROM boxes WHERE ${where}`).get().n;
export const freshCount = () => count("status IN ('warming', 'idle')");
export const totalCount = () => count("1 = 1");

let filling = false;
// Keep POOL_SIZE fresh boxes, without ever exceeding MAX_BOXES in total (fresh + busy + parked).
export async function refill() {
  if (filling) return;
  filling = true;
  try {
    const want = Math.min(config.poolSize - freshCount(), config.maxBoxes - totalCount());
    await Promise.all(Array.from({ length: Math.max(0, want) }, createBox));
  } finally {
    filling = false;
  }
}

// Atomically take one fresh box for a session. Returns the box or undefined.
export function claimBox(sessionId) {
  return db
    .prepare(
      `UPDATE boxes SET status = 'busy', session_id = ?, claimed_at = ?, parked_at = NULL
       WHERE id = (SELECT id FROM boxes WHERE status = 'idle' ORDER BY created_at LIMIT 1)
       RETURNING *`,
    )
    .get(sessionId, now());
}

export const boxForSession = (sessionId) => db.prepare("SELECT * FROM boxes WHERE session_id = ?").get(sessionId);
export const markBusy = (id) => db.prepare("UPDATE boxes SET status = 'busy', parked_at = NULL WHERE id = ?").run(id);
export const parkBox = (id) => db.prepare("UPDATE boxes SET status = 'parked', parked_at = ? WHERE id = ?").run(now(), id);
export const oldestParked = () => db.prepare("SELECT * FROM boxes WHERE status = 'parked' ORDER BY parked_at LIMIT 1").get();
export const expiredParked = (maxAgeMs) =>
  db.prepare("SELECT * FROM boxes WHERE status = 'parked' AND parked_at < ?").all(new Date(Date.now() - maxAgeMs).toISOString());

// Copy a box's repo and Claude history out to the session's state dir (host side, before the box is destroyed).
export async function saveState(box, sessionId) {
  const dest = sessionStateDir(sessionId);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const { workspace, claude } = slotPaths(box.slot_dir);
  await run("cp", ["-a", workspace, join(dest, "workspace")]);
  await run("cp", ["-a", claude, join(dest, "claude")]);
}

// Copy a sleeping session's state into a freshly claimed box. Contents are copied into the existing
// folders (not replacing them), because the box's bind mounts point at those exact folders.
export async function restoreState(box, sessionId) {
  const src = sessionStateDir(sessionId);
  if (!existsSync(src)) throw new Error(`no saved state for ${sessionId}`);
  const { workspace, claude } = slotPaths(box.slot_dir);
  await run("cp", ["-a", `${join(src, "workspace")}/.`, workspace]);
  await run("cp", ["-a", `${join(src, "claude")}/.`, claude]);
}

// Boxes are never reused across sessions: a finished box is destroyed and replaced.
export async function releaseBox(id) {
  db.prepare("UPDATE boxes SET status = 'draining' WHERE id = ?").run(id);
  await destroyBox(id);
  refill();
}

// On startup, remove every container the DB doesn't know as a fresh box. Parked boxes are handled by the runner
// (their state is saved first), so this returns them instead of deleting them.
export async function reconcile() {
  const names = (await docker("ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{.Names}}")).split("\n").filter(Boolean);
  const keep = new Set(db.prepare("SELECT container FROM boxes WHERE status IN ('idle', 'parked')").all().map((b) => b.container));
  for (const name of names) if (!keep.has(name)) await docker("rm", "-f", name).catch(() => {});
  for (const box of db.prepare("SELECT * FROM boxes WHERE status NOT IN ('idle', 'parked')").all()) await destroyBox(box.id);
  for (const box of db.prepare("SELECT * FROM boxes WHERE status = 'idle'").all())
    if (!names.includes(box.container)) await destroyBox(box.id);
  return db.prepare("SELECT * FROM boxes WHERE status = 'parked'").all();
}

export const listBoxes = () => db.prepare("SELECT * FROM boxes ORDER BY created_at").all();
