import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.mjs";

const run = promisify(execFile);
const git = (args, opts = {}) => run("git", args, { maxBuffer: 64 * 1024 * 1024, ...opts }).then((r) => r.stdout.trim());

// The GitHub token lives only on the host and only on the command line of host-side git calls.
// It is never written to .git/config, so the agent can't read it from the mounted workspace.
const auth = () =>
  config.github.token
    ? ["-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${config.github.token}`).toString("base64")}`]
    : [];

export const normalizeRepo = (repo) => repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
const remote = (repo) => `https://github.com/${repo}.git`;

// A host-side bare mirror per repo acts as the "snapshot": each checkout is a fast local clone plus an incremental fetch.
async function mirror(repo) {
  mkdirSync(config.mirrorsDir, { recursive: true });
  const dir = join(config.mirrorsDir, `${repo.replace("/", "__")}.git`);
  if (!existsSync(dir)) await git([...auth(), "clone", "--mirror", remote(repo), dir]);
  else await git([...auth(), "-C", dir, "remote", "update", "--prune"]);
  return dir;
}

export async function checkout(repo, slotDir, branch, baseBranch) {
  const src = await mirror(repo);
  await git(["clone", "--no-hardlinks", ...(baseBranch ? ["--branch", baseBranch] : []), src, slotDir]);
  await git(["-C", slotDir, "remote", "set-url", "origin", remote(repo)]);
  await git(["-C", slotDir, "checkout", "-b", branch]);
  return git(["-C", slotDir, "rev-parse", "--abbrev-ref", "origin/HEAD"]).then((r) => r.replace("origin/", "")).catch(() => baseBranch || "main");
}

// Commit anything the agent left uncommitted (it may also have committed on its own).
export async function commitAll(slotDir, message) {
  await git(["-C", slotDir, "add", "-A"]);
  if (await git(["-C", slotDir, "status", "--porcelain"]))
    await git(["-C", slotDir, "-c", "user.name=agentbox", "-c", "user.email=agentbox@localhost", "commit", "-m", message]);
}

export const diffStat = (slotDir, baseBranch) => git(["-C", slotDir, "diff", "--stat", `origin/${baseBranch}..HEAD`]);

export async function hasChangesVsBase(slotDir, baseBranch) {
  const n = await git(["-C", slotDir, "rev-list", "--count", `origin/${baseBranch}..HEAD`]).catch(() => "0");
  return Number(n) > 0;
}

// True if HEAD is already what we last pushed to the session branch (push updates origin/<branch>).
export async function alreadyPushed(slotDir, branch) {
  const [head, remote] = await Promise.all([
    git(["-C", slotDir, "rev-parse", "HEAD"]),
    git(["-C", slotDir, "rev-parse", `origin/${branch}`]).catch(() => null),
  ]);
  return head === remote;
}

export const diff = (slotDir, baseBranch) => git(["-C", slotDir, "diff", `origin/${baseBranch}..HEAD`]);

export async function push(slotDir, branch) {
  if (!config.github.token) return false;
  await git([...auth(), "-C", slotDir, "push", "origin", `HEAD:refs/heads/${branch}`]);
  return true;
}

export async function openPr({ repo, branch, baseBranch, title, body }) {
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.github.token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
    body: JSON.stringify({ title, head: branch, base: baseBranch, body }),
  });
  if (!res.ok) throw new Error(`GitHub PR create failed: ${res.status} ${await res.text()}`);
  return (await res.json()).html_url;
}
