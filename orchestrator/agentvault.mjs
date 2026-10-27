import { config } from "./config.mjs";

// Infisical machine identity (Universal Auth) -> access token, cached until shortly before expiry.
let cached = { token: null, exp: 0 };

async function accessToken() {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const res = await fetch(`${config.infisical.url}/api/v1/auth/universal-auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: config.infisical.clientId, clientSecret: config.infisical.clientSecret }),
  });
  if (!res.ok) throw new Error(`Infisical login failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  cached = { token: body.accessToken, exp: Date.now() + body.expiresIn * 1000 };
  return cached.token;
}

async function call(method, path, body) {
  const res = await fetch(`${config.infisical.url}/api/v1/agent-vault${path}`, {
    method,
    headers: { authorization: `Bearer ${await accessToken()}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Agent Vault ${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// One Agent Vault session per agentbox session: scoped to one access bundle, short TTL, revoked at the end.
export async function mintSession() {
  const { session } = await call("POST", "/sessions", {
    accessBundles: [config.infisical.accessBundle],
    ttl: config.infisical.sessionTtl,
  });
  return { id: session.id, token: session.token, expiresAt: session.expiresAt };
}

export async function revokeSession(id) {
  await call("POST", `/sessions/${id}/revoke`);
}

export const proxyUrl = (token) => `http://x-agent-vault:${encodeURIComponent(token)}@${config.proxyAddr}`;
