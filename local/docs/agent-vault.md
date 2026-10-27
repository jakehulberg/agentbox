# Agent Vault: how credentials reach the agent

Agent Vault is Infisical's credential broker for agents. The agent sends requests with a placeholder, a proxy swaps in the real credential on the way out, and the agent never holds the secret. In agentbox, it's what lets Claude call Anthropic without the API key ever being in the box.

## The pieces

| Piece | Where | What |
|---|---|---|
| **Infisical** | mini3, `http://192.168.1.203:8080` | Stores the services and credentials, issues sessions, keeps the audit log |
| **Proxy** `mini3-proxy` | mini3, container `agent-vault-proxy`, port `17323` | Where box traffic goes. Checks the session, attaches the credential, forwards |
| **Access bundle** `agentbox` | In Infisical | The set of services a session can use |
| **Machine identity** `agentbox-orchestrator` | In Infisical; its client ID/secret in mini2's `~/agentbox/.env` | How the orchestrator logs in to mint sessions |
| **Session** | Minted per turn | A time-bound grant for one bundle. Its token is what the box sends to the proxy |

## What's configured

| Object | Value |
|---|---|
| Agent Vault project | One project for agentbox |
| Proxy | `mini3-proxy`, traffic policy **Any host**, poll every 30 s, CA fingerprint `SHA256:C3:49:72:0B:…:4A:B9`. Runs as `infisical/cli agent-vault proxy`, state in Docker volume `agent-vault-proxy` |
| Service `anthropic` | host `api.anthropic.com`, header `x-api-key`, no prefix, the test key |
| Service `httpbin-demo` | host `httpbin.org`, `Authorization: Bearer agentbox-demo-secret-that-the-agent-never-sees`, for demos |
| Machine identity | `agentbox-orchestrator`, Universal Auth, org role no-access, Agent Vault role member, granted `agentbox` |

## A turn, from the credential's point of view

```mermaid
sequenceDiagram
    participant O as Orchestrator (mini2)
    participant I as Infisical (mini3)
    participant B as Box
    participant P as Proxy (mini3)
    participant A as api.anthropic.com

    O->>I: universal-auth login (machine identity)
    O->>I: POST /api/v1/agent-vault/sessions {bundle: agentbox, ttl: 45m}
    I-->>O: session id + token
    O->>B: docker exec claude, HTTPS_PROXY=http://x-agent-vault:TOKEN@av-relay:17323,<br/>ANTHROPIC_API_KEY=placeholder
    B->>P: request, x-api-key: placeholder
    P->>I: is this session live? what's in its bundle? (cached, re-checked every 30 s)
    P->>A: same request, x-api-key: real key
    A-->>B: response
    O->>I: POST /sessions/:id/revoke (turn over)
```

## Lifetimes

| | |
|---|---|
| Session TTL | 45 minutes (`AV_SESSION_TTL`) |
| Actually lives | One turn: revoked the moment the turn ends, success or failure. Usually seconds to a few minutes |
| After revoke | The proxy stops attaching credentials within its 30 s poll interval |
| If the orchestrator crashes | It revokes mid-turn sessions on restart; anything missed still expires at 45 min |
| Idle or sleeping sessions | Hold **no** live Agent Vault session |

Every session shows up in Infisical under **Agent Vault → Sessions** with actor `agentbox-orchestrator`, and each mint and revoke is in the audit log. `sessions.av_session_id` in [SQLite](sqlite.md) is the join key back to agentbox.

## What's brokered and what isn't

| Credential | Brokered? | |
|---|---|---|
| Anthropic API key | **Yes** | The box has `ANTHROPIC_API_KEY=sk-ant-api03-agentbox-placeholder-…` |
| Anything on `httpbin.org` | **Yes** | Demo |
| GitHub | **No** | The orchestrator pushes and opens PRs from the host. The agent can't reach GitHub at all, which is why "how many issues do I have" fails |

Adding a capability is adding a service to the bundle. For GitHub: a service for `api.github.com` and `github.com` holding the token, with path rules limited to the repo, plus `gh` in the golden image with a placeholder `GH_TOKEN`. The agent could then read issues and answer review comments, and the token would still never enter the box.

## Setting up the box to use it

Nothing in the agent changes. It's all standard HTTP proxy plumbing:

- `HTTPS_PROXY` / `HTTP_PROXY` point at the relay with the session token as the proxy password (set at `docker exec`).
- The proxy's CA is baked into the golden image, so TLS through the proxy is trusted.
- `NODE_USE_ENV_PROXY=1` makes Node's built-in fetch honor the proxy.

## Known gaps

- Proxy request logs record the Infisical actor (the orchestrator's machine identity), not which agentbox session made the call. `av_session_id` in SQLite is how you connect them.
- Which bundle a session gets is hardcoded (`agentbox`). The policy layer (bundle per user, per repo, or per task) belongs in the orchestrator and isn't built yet.
