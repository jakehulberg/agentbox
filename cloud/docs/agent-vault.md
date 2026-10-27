# Agent Vault

Replaces: Agent Vault + Infisical on mini3 (see [agentbox agent-vault.md](../../local/docs/agent-vault.md)).

Agent Vault runs in **Infisical Cloud** (`app.infisical.com`). It's org-wide, so there's no project to pick. **Access bundles** hold **services**, a service holds a credential for a host, and a **session** (grant) is a short-lived token for one or more bundles. The sandbox sends the token to the proxy; the proxy checks it, matches the host to a service in the grant's bundles, and attaches the credential.

## The proxy

| | |
|---|---|
| Name | `do-proxy` |
| Where | `agentbox-proxy` droplet (1 vCPU / 1 GB), container `agent-vault-proxy`, `infisical/cli:0.43.137 agent-vault proxy` |
| Listens | `10.60.0.2:17323` (VPC only) |
| State | Docker volume `agent-vault-proxy` (enrollment + CA) |
| CA | SHA256 `92:63:F5:D4:26:44:32:F1:…:21:CD:AD:1B`, served at `/_agent-vault/ca` (JSON), baked into the golden image |
| Policy | Access bundle hosts only |

## Bundles and services

| Bundle | Service | Host | Credential | Used for |
|---|---|---|---|---|
| `agent-turn` | `anthropic` | `api.anthropic.com` | `x-api-key` | Claude's turn |
| `agent-turn` | `httpbin-demo` | `httpbin.org` | `Authorization: Bearer agentbox-demo-secret-…` | Smoke test |
| `finish` | GitHub (template) | `api.github.com` | `Authorization: Bearer <bot token>` | Open the PR |
| `finish` | `github-git` | `github.com` | Basic, `x-access-token` + bot token | `git push` |

The agent's bundle has no GitHub service at all: the fork is public and baked into the image, so the agent never needs GitHub. Only `finish.sh`, run by the DO after Claude exits, gets GitHub.

## Grants per turn

| Step | Bundle | TTL | Minted | Revoked |
|---|---|---|---|---|
| Claude runs | `agent-turn` | 45 min | before `claude -p` | as soon as it exits |
| `finish.sh` | `finish` | 5 min | after `pkill -u agent` | as soon as it exits |
| Idle / sleeping | none | | | |

Minted and revoked by the Session DO with machine identity **`agentbox-cloud`** (Universal Auth, org role no access, member of Agent Vault, granted both bundles). It can mint and revoke grants for those bundles and can't read any credential.

## Audit

Every mint and revoke shows under Agent Vault → Sessions with actor `agentbox-cloud`; every proxied request is in the proxy's logs. `turns.av_session_id` in the DO joins a grant back to a session, turn and user.
