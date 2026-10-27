import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Load ~/agentbox/.env (KEY=VALUE lines) without a dependency.
const ROOT = process.env.AGENTBOX_HOME || join(homedir(), "agentbox");
const envFile = join(ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const env = (k, d) => process.env[k] ?? d;

export const config = {
  root: ROOT,
  dbPath: join(ROOT, "state", "agentbox.db"),
  slotsDir: join(ROOT, "slots"),
  mirrorsDir: join(ROOT, "mirrors"),
  sessionsDir: join(ROOT, "sessions"),
  listen: { host: env("ORCH_HOST", "0.0.0.0"), port: Number(env("ORCH_PORT", "8787")) },
  apiToken: env("ORCH_API_TOKEN", ""),

  docker: {
    context: env("DOCKER_CONTEXT", "colima-agentbox"),
    image: env("GOLDEN_IMAGE", "agentbox/golden:latest"),
    network: env("AGENT_NETWORK", "agentnet"),
    cpus: env("BOX_CPUS", "1"),
    memory: env("BOX_MEMORY", "1536m"),
  },
  poolSize: Number(env("POOL_SIZE", "3")),      // fresh boxes kept warm
  maxBoxes: Number(env("MAX_BOXES", "6")),      // fresh + busy + parked
  idleTimeoutMs: Number(env("IDLE_TIMEOUT_MIN", "5")) * 60_000, // how long a finished session keeps its box
  sessionTimeoutMs: Number(env("SESSION_TIMEOUT_MIN", "30")) * 60_000,
  maxTurns: Number(env("MAX_TURNS", "40")),

  infisical: {
    url: env("INFISICAL_URL", "http://192.168.1.203:8080"),
    clientId: env("INFISICAL_CLIENT_ID", ""),
    clientSecret: env("INFISICAL_CLIENT_SECRET", ""),
    accessBundle: env("AV_ACCESS_BUNDLE", "agentbox"),
    sessionTtl: env("AV_SESSION_TTL", "45m"),
  },
  // Address of the Agent Vault proxy as seen from inside a box (the relay on agentnet).
  proxyAddr: env("AV_PROXY_ADDR", "av-relay:17323"),
  // Placeholder the agent sends; the proxy swaps the real key in on the way out.
  anthropicPlaceholder: env("ANTHROPIC_PLACEHOLDER", "sk-ant-api03-agentbox-placeholder-000000000000000000000000000000000000000000000000000000000000000000000000000000-AAAAAAAA"),

  github: { token: env("GITHUB_TOKEN", "") },
};
