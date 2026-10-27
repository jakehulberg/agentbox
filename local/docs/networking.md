# Networking: the Colima VM, agentnet and the relay

The network is what makes "the agent never holds a real credential" actually hold. A box has no route to the internet at all. Its only way out is through the Agent Vault proxy, which attaches credentials for approved services.

## The layers

```mermaid
flowchart LR
    subgraph mini2["mini2 (macOS) · 192.168.1.201 · ts 100.124.121.114"]
        Orch["orchestrator :8787"]
        subgraph VM["Colima VM 'agentbox' · 192.168.64.3"]
            subgraph agentnet["agentnet 172.30.0.0/24 · --internal"]
                B1["box .3"]
                B2["box .4"]
                B3["box .5"]
                Relay["av-relay .2"]
            end
            Bridge["bridge 172.17.0.0/16"]
        end
    end
    subgraph mini3["mini3 · ts 100.127.68.84"]
        Proxy["Agent Vault proxy :17323"]
    end
    B1 & B2 & B3 -- "HTTPS_PROXY" --> Relay
    Relay --- Bridge
    Bridge -- "Tailscale (WireGuard)" --> Proxy
    B1 -. "no route" .-x Internet((internet))
```

| Layer | What | Address |
|---|---|---|
| mini2 | The Mac. Runs the orchestrator | LAN `192.168.1.201`, Tailscale `100.124.121.114` |
| Colima VM `agentbox` | A Linux VM that runs Docker (macOS has no Linux kernel). Separate from the `default` VM that runs grafana/postgres/homelab | `192.168.64.3`, 6 CPU, 10 GB, 60 GB, `vz`, Docker context `colima-agentbox` |
| `agentnet` | A Docker network created with `--internal`: **no gateway to the outside** | `172.30.0.0/24`, gateway `.1` |
| Boxes | On `agentnet` only | `172.30.0.3` and up, dynamic |
| `av-relay` | `alpine/socat` on both `agentnet` and the normal bridge. Forwards TCP `:17323` to mini3's proxy | `172.30.0.2` on agentnet, `172.17.0.2` on bridge |
| mini3 | Runs Infisical and the Agent Vault proxy | LAN `192.168.1.203`, Tailscale `100.127.68.84` |

## How a request leaves a box

1. Claude calls `https://api.anthropic.com` with `x-api-key: <placeholder>`.
2. `HTTPS_PROXY=http://x-agent-vault:<session-token>@av-relay:17323` sends it to the relay instead.
3. The relay passes the bytes over Tailscale to `100.127.68.84:17323`.
4. The Agent Vault proxy checks the session token, decrypts the request (the box trusts its CA), swaps the placeholder for the real key, and sends it to Anthropic.

Anything that ignores `HTTPS_PROXY` just fails: there's no other route.

## Verified

```bash
# from a box, straight out: fails
docker exec <box> curl -m5 https://httpbin.org/get                      # → 000, blocked
# through the proxy with a session token: the real secret arrives, the box only sent a placeholder
docker exec -e HTTPS_PROXY=http://x-agent-vault:<token>@av-relay:17323 <box> \
  curl -s -H "Authorization: Bearer placeholder" https://httpbin.org/headers
# → "Authorization": "Bearer agentbox-demo-secret-that-the-agent-never-sees"
```

## Why a relay, and why Tailscale

- **Why the relay:** an `--internal` network can't reach mini3 at all, which is the point. The relay is one small, auditable hole that only leads to the proxy.
- **Why Tailscale and not the LAN:** the Colima VM couldn't reach the `192.168.1.x` LAN in testing (connection refused), but Tailscale works. It also encrypts the hop between the minis, which matters because the session token travels as plain HTTP proxy auth.

## What the orchestrator's own traffic does

The orchestrator runs on the mini2 host, outside the VM, so it uses the normal network:

| To | For |
|---|---|
| `http://100.127.68.84:8080` (Infisical) | Machine identity login, mint and revoke Agent Vault sessions |
| `github.com` / `api.github.com` | Mirror fetch, push, open PR |
| The Docker socket of `colima-agentbox` | Create, exec into and remove boxes |

## Limits of this setup

- The proxy's traffic policy is **Any host**: requests to hosts with no service are forwarded without credentials, so the agent can reach public websites and package registries. Switching the proxy to **Access bundle hosts only** would make the bundle an allowlist.
- Box-to-box traffic on `agentnet` isn't blocked (Docker allows it by default on one network). One network per box, or `--icc=false`, would close that.
