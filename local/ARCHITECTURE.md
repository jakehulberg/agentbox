# agentbox: Architecture

A small Ramp-style background coding agent platform running on two Mac minis. You send a task, the orchestrator claims a pre-warmed sandbox, Claude Code does the work inside it, and the orchestrator opens a PR. The agent never holds a real credential: model calls go through the Agent Vault proxy, and git credentials stay on the host.

> **Status (2026-09-25):** Running end to end. Verified: a box has no direct internet; through the relay and the mini3 proxy, `httpbin.org` receives the real secret while the box only sends a placeholder; a full `agentbox run` claims a box, clones, mints an Agent Vault session, runs Claude Code, streams events, revokes the session and replaces the box. First real session (`s-…`, octocat/Hello-World) succeeded in 2 turns for $0.036.

## 1. The big picture

```mermaid
flowchart LR
    subgraph Clients
        CLI["agentbox CLI"]
        Slack["Slack bot (later)"]
    end

    subgraph mini2["mini2 · 192.168.1.201 · ts 100.124.121.114"]
        Orch["Orchestrator<br/>node :8787<br/>SQLite state"]
        Mirrors[("git mirrors<br/>~/agentbox/mirrors")]
        subgraph VM["Colima VM 'agentbox' · 192.168.64.3"]
            subgraph agentnet["agentnet 172.30.0.0/24 (internal, no internet)"]
                B1["box 172.30.0.3"]
                B2["box 172.30.0.5"]
                B3["box 172.30.0.6"]
                Relay["av-relay 172.30.0.2"]
            end
        end
    end

    subgraph mini3["mini3 · 192.168.1.203 · ts 100.127.68.84"]
        Proxy["Agent Vault proxy :17323"]
        Inf["Infisical (dev) :8080"]
    end

    Anthropic["api.anthropic.com"]
    GitHub["github.com"]

    CLI -- "HTTP + SSE" --> Orch
    Slack -. "HTTP + SSE" .-> Orch
    Orch -- "docker exec" --> B1
    Orch -- "clone/push/PR<br/>(GITHUB_TOKEN, host only)" --> GitHub
    Orch -- "mint/revoke session<br/>(machine identity)" --> Inf
    B1 & B2 & B3 -- "HTTPS_PROXY" --> Relay
    Relay -- "TCP 17323 over Tailscale" --> Proxy
    Proxy -- "fetch creds per session" --> Inf
    Proxy -- "real API key attached" --> Anthropic
```

## 2. Machines, addresses and networks

| Thing | Where | Address | Notes |
|---|---|---|---|
| mini2 (host) | LAN / Tailscale | `192.168.1.201` / `100.124.121.114` | Runs the orchestrator and the sandbox VM |
| Colima VM `agentbox` | mini2 | `192.168.64.3` | 6 CPU, 10 GB, 60 GB, `vz`. Separate from the `default` Colima VM that runs grafana/postgres/homelab. Docker context `colima-agentbox` |
| `agentnet` | inside the VM | `172.30.0.0/24`, gateway `.1` | Docker network created with `--internal`: containers on it have **no route to the internet**. Verified with a blocked `wget` to 1.1.1.1 |
| `av-relay` | inside the VM | `172.30.0.2` on agentnet, `172.17.0.2` on bridge | `alpine/socat` forwarding `:17323` to mini3's Tailscale IP `100.127.68.84:17323`. The only thing on agentnet that can leave it. (The Colima VM can't reach the `192.168.1.x` LAN, but Tailscale works, and it encrypts the hop) |
| Warm-pool boxes | inside the VM | `172.30.0.3+` (dynamic) | One container per box, named `agentbox-box-<id>` |
| Orchestrator | mini2 host | `0.0.0.0:8787` | Node 25, no npm deps, runs in tmux session `agentbox` under `bin/run-orchestrator` (restarts it if it crashes). Bearer-token auth (`ORCH_API_TOKEN`). Talks to Infisical at `http://100.127.68.84:8080` |
| mini3 (host) | LAN / Tailscale | `192.168.1.203` / `100.127.68.84` | |
| Infisical | mini3 | `http://192.168.1.203:8080` | Self-hosted Infisical with Agent Vault enabled |
| Agent Vault proxy | mini3 | `0.0.0.0:17323` | Container `agent-vault-proxy` (`infisical/cli` 0.43.137, `agent-vault proxy`), volume `agent-vault-proxy` holds its enrollment and CA. Name `mini3-proxy`, traffic policy **Any host**, poll 30s, CA `SHA256:C3:49:72:0B:…:4A:B9`. Reaches Infisical via `host.docker.internal:8080` |

Why the relay: an `--internal` network can't reach mini3 at all, which is the point. The relay is a single, auditable hole that only leads to the Agent Vault proxy. A box that ignores `HTTPS_PROXY` simply gets no network.

## 3. The golden image

`agentbox/golden:latest` (≈939 MB), built from [`golden/Dockerfile`](golden/Dockerfile):

| Layer | Contents |
|---|---|
| Base | `node:22-bookworm-slim` |
| Tools | git, curl, jq, ripgrep, python3, make, procps |
| Agent | Claude Code (`@anthropic-ai/claude-code`, 2.1.283 at build time) |
| Trust | Agent Vault proxy CA copied to `/usr/local/share/ca-certificates/agent-vault.crt` and added to the system store. `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO` all point at it. Fingerprint `SHA256:C3:49:72:0B:…:4A:B9`, fetched from the proxy's `/_agent-vault/ca` |
| Proxy behavior | `NODE_USE_ENV_PROXY=1` so Node's built-in fetch honors `HTTPS_PROXY` |
| Quiet | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1`, `IS_SANDBOX=1` |
| User | `agent` (uid 1001), workdir `/workspace` |
| Command | `sleep infinity` (the box idles until the orchestrator `docker exec`s into it) |

What the image does **not** contain: any API key, any git credential, any session token. Those only exist at `docker exec` time, and only as short-lived values.

Each box runs with `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 1024`, `--cpus 1`, `--memory 1536m`, and two host folders mounted in: `slots/<box>/workspace` at `/workspace` (the repo) and `slots/<box>/claude` at `/home/agent/.claude` (Claude Code's conversation history, which is what makes resuming possible).

**Pool sizing:** 3 fresh boxes are kept warm (`POOL_SIZE`), and there are never more than 6 boxes in total (`MAX_BOXES`), counting fresh, busy and parked. Six busy boxes at 1.5 GB fit inside the VM's 10 GB.

## 4. How a session flows

```mermaid
sequenceDiagram
    participant U as You (CLI / Slack)
    participant O as Orchestrator (mini2)
    participant DB as SQLite
    participant B as Box (agentnet)
    participant I as Infisical (mini3)
    participant P as Agent Vault proxy (mini3)
    participant A as api.anthropic.com
    participant G as GitHub

    U->>O: POST /sessions {repo, prompt}
    O->>DB: insert session (queued)
    O->>DB: claim idle box (atomic UPDATE ... RETURNING)
    O->>G: fetch into host mirror, clone into box's slot dir
    O->>I: universal-auth login, POST /agent-vault/sessions
    I-->>O: session id + token (TTL 45m)
    O->>B: docker exec claude -p ... with HTTPS_PROXY=http://x-agent-vault:TOKEN@av-relay:17323
    B->>P: model call, x-api-key: placeholder
    P->>I: is this session live? which bundle?
    P->>A: same call with the real key
    A-->>B: response
    B-->>O: stream-json events on stdout
    O->>DB: every event -> session_events
    O-->>U: SSE stream
    O->>G: commit, push branch, open PR (host-side token)
    O->>I: revoke Agent Vault session
    O->>B: park the box (idle, waiting for a follow-up)
    Note over O,B: after 15 min idle: save state to the host, docker rm -f, start a replacement box
```

Step by step:

1. **Queue.** `POST /sessions` inserts a row with status `queued`. The scheduler runs sessions FIFO whenever a box is idle, so concurrency equals `POOL_SIZE` (3).
2. **Claim.** One SQL statement flips a box from `idle` to `busy` and returns it, so two sessions can never grab the same box.
3. **Checkout.** The orchestrator keeps a bare mirror per repo in `~/agentbox/mirrors` and clones from it into the box's slot dir `~/agentbox/slots/<box>`, which is bind-mounted at `/workspace`. The branch is `agentbox/<session-id>`. The GitHub token is passed only on the host's git command line (`http.extraHeader`) and never written to `.git/config`, so the agent can't read it from the mount.
4. **Mint.** The orchestrator logs in to Infisical as a machine identity and creates an Agent Vault session scoped to the `agentbox` access bundle, TTL 45 minutes.
5. **Run.** `docker exec -u agent` starts Claude Code headless (`claude -p --output-format stream-json --dangerously-skip-permissions --max-turns 40`). `HTTPS_PROXY` carries the session token. `ANTHROPIC_API_KEY` is a placeholder that the proxy replaces.
6. **Stream.** Each JSON line Claude prints is stored as a `session_events` row and pushed to anyone following over SSE.
7. **Ship.** After the agent exits, the orchestrator commits leftovers, pushes the branch and opens a PR. Without a `GITHUB_TOKEN`, the diff is stored in the events instead.
8. **Park.** The Agent Vault session is revoked and the box is parked so a follow-up can resume instantly. After 15 idle minutes the session's repo and Claude history are saved on mini2, the box is destroyed, and a fresh box replaces it. A box never serves a second session.

## 4b. Session lifecycle: idle, sleeping and follow-ups

A session is a conversation, not a single run. Every message (the first prompt or a follow-up) is one **turn**, and all turns land on the same branch and the same PR.

```mermaid
stateDiagram-v2
    [*] --> queued: POST /sessions
    queued --> running: fresh box claimed, repo cloned
    running --> idle: turn done, pushed, box PARKED
    idle --> running: follow-up (same box, claude --resume)
    idle --> sleeping: idle 15 min, evicted for room, or orchestrator restart
    sleeping --> running: follow-up (fresh box, state restored, claude --resume)
    running --> failed: error or timeout
    running --> cancelled: cancel
    idle --> cancelled: cancel
    sleeping --> cancelled: cancel
```

| State | Box | Where the repo and Claude history are | A follow-up... |
|---|---|---|---|
| `idle` | Parked, still running | In the box's slot folders | Runs instantly in the same box |
| `sleeping` | Destroyed | Copied to `~/agentbox/sessions/<session-id>/` on mini2 | Claims a fresh box, copies the state in, resumes (a few seconds) |
| `failed` / `cancelled` | Destroyed | Gone | Rejected; start a new session |

How a turn resumes: the orchestrator stores Claude Code's own session id (`claude_session_id`) and runs `claude -p "<follow-up>" --resume <id>`. Claude reads its conversation file from `~/.claude/projects/...` and continues with full memory of earlier turns, in the same `/workspace` path.

Each turn mints its own Agent Vault session and revokes it when the turn ends, so an idle or sleeping session holds **no live credential**.

Making room: if a new session needs a box, there are no fresh ones, and the 6-box cap is reached, the orchestrator puts the longest-idle session to sleep to free a slot.

Verified on `jakehulberg2/demo-app` (session `s-c4647493`, PR #36): turn 1 created `docs/FAQ.md`; the orchestrator restarted, which put the session to sleep; turn 2 restored it into a new box and the agent correctly recalled "In my previous turn I created docs/FAQ.md" and updated the same PR; turn 3 ran in the parked box.

## 5. State and session tracking

All state lives in one SQLite file, `~/agentbox/state/agentbox.db` on mini2 (WAL mode).

```mermaid
erDiagram
    sessions ||--o{ session_events : has
    sessions ||--o{ session_messages : "turns"
    session_messages {
        int id PK
        text session_id FK
        text prompt
        text author
        text status "pending running done failed"
        text created_at
    }
    sessions |o--o| boxes : "runs on"
    sessions {
        text id PK "s-xxxxxxxx"
        text status "queued starting running pushing idle sleeping failed cancelled"
        text prompt
        text repo "owner/name"
        text base_branch
        text branch "agentbox/<id>"
        text requested_by
        text source "cli api slack"
        text box_id
        text av_session_id "Agent Vault grant"
        text claude_session_id "Claude Code's own id"
        real cost_usd
        int num_turns
        text pr_url
        text error
        text created_at
        text started_at
        text finished_at
    }
    session_events {
        int seq PK
        text session_id FK
        text ts
        text kind "status agent log error result pr"
        text data "JSON"
    }
    boxes {
        text id PK "box-xxxxxx"
        text container
        text ip
        text slot_dir
        text status "warming idle busy parked draining"
        text parked_at
        text session_id
        text created_at
        text claimed_at
    }
```

How each tracking question is answered:

| Question | Where it's answered |
|---|---|
| What's running right now? | `sessions.status`, `boxes.status` (`agentbox ls`, `agentbox pool`) |
| What did the agent do? | `session_events` rows of kind `agent` (every tool call and message from Claude's stream-json) |
| How much did it cost? | `sessions.cost_usd` and `num_turns`, from Claude's final `result` event |
| Who asked for it? | `sessions.requested_by` and `source` |
| Which credentials could it use? | `sessions.av_session_id` links to the Agent Vault session in Infisical, which records the bundle, the actor (the machine identity) and create/revoke audit events |
| Can I watch it live? | `GET /sessions/:id/events` (SSE). Reconnect with `?after=<seq>` or `Last-Event-ID` to resume without gaps |
| What if it hangs? | 30-minute timeout kills the exec. `POST /sessions/:id/cancel` kills it on demand |
| Can I pick a session back up? | Yes: `session_messages` holds every turn, and a follow-up resumes Claude's conversation (see 4b) |
| What if the orchestrator restarts? | On boot it marks mid-turn sessions `failed` and revokes their Agent Vault sessions, puts parked sessions to sleep (state saved, so they stay resumable), removes every other box, and refills the pool |

Known gap: Agent Vault's proxy logs record the Infisical actor (the orchestrator's machine identity), not the agentbox session. `av_session_id` in SQLite is the join key between the two.

## 6. Interfaces

**HTTP API** on `mini2:8787` (header `Authorization: Bearer $ORCH_API_TOKEN`):

| Method | Path | Does |
|---|---|---|
| `POST` | `/sessions` | `{repo, prompt, baseBranch?, requestedBy?, source?}` creates and queues a session |
| `GET` | `/sessions` | Last 50 sessions |
| `GET` | `/sessions/:id` | One session |
| `GET` | `/sessions/:id/events` | SSE stream: replay, then live, closes when the session settles (idle, sleeping, failed or cancelled with nothing pending) |
| `POST` | `/sessions/:id/messages` | `{prompt, author?}` follow-up. Queued if a turn is running, instant if idle, restored if sleeping |
| `POST` | `/sessions/:id/cancel` | Cancel |
| `GET` | `/pool` | Boxes and their state |
| `GET` | `/healthz` | Liveness (no auth) |

**CLI** (`~/agentbox/bin/agentbox` on mini2, or anywhere with `AGENTBOX_URL` and `ORCH_API_TOKEN` set):

```bash
agentbox run owner/repo "fix the flaky login test"   # queue and follow
agentbox run owner/repo "..." --detach               # queue only
agentbox ls
agentbox send s-c4647493 "also add tests"           # follow-up: resumes the same session
agentbox logs s-4ac82fb7                             # follow a session
agentbox cancel s-4ac82fb7
agentbox pool
```

**Slack (next):** a bot that calls `POST /sessions` with `source: "slack"` and `requestedBy: <slack user>`, then follows `/events` and posts updates in the thread. No orchestrator changes needed.

## 7. Where each credential lives

| Credential | Held by | Ever inside a box? |
|---|---|---|
| Anthropic API key | Agent Vault service in Infisical (mini3), attached by the proxy | **No**, the box has a placeholder |
| Agent Vault session token | Minted per session by the orchestrator | Yes, in the exec env, valid ≤45 min, revoked at session end |
| Infisical machine identity (client id/secret) | `~/agentbox/.env` on mini2 (mode 600) | No |
| GitHub token | `~/agentbox/.env` on mini2 | No, only on host-side git command lines |
| Orchestrator API token | `~/agentbox/.env` on mini2 | No |

The session token is sent to the proxy as HTTP basic auth on a plain-HTTP proxy connection. Inside the VM that hop is box to relay on `agentnet`; between the minis it rides Tailscale (WireGuard), so it's never in the clear on the LAN.

## 8. Operating it

```bash
# mini2
tmux attach -t agentbox                         # orchestrator logs
tail -f ~/agentbox/orchestrator.log
DOCKER_CONTEXT=colima-agentbox docker ps        # boxes + relay
sqlite3 ~/agentbox/state/agentbox.db 'select id,status,cost_usd,pr_url from sessions order by created_at desc limit 10'

# rebuild the golden image (e.g. after the proxy CA changes)
cd ~/agentbox/golden && DOCKER_CONTEXT=colima-agentbox docker build -t agentbox/golden:latest .
# then restart the orchestrator; reconcile() replaces boxes on boot
```

Source: [`orchestrator/`](orchestrator) (`config`, `db`, `pool`, `agentvault`, `git`, `runner`, `server`), [`bin/agentbox`](bin/agentbox), [`golden/Dockerfile`](golden/Dockerfile).

## What's configured in Infisical (mini3)

| Object | Value |
|---|---|
| Agent Vault project | One project for agentbox |
| Proxy | `mini3-proxy` (see table in section 2) |
| Access bundle | `agentbox` |
| Service `anthropic` | host `api.anthropic.com`, header `x-api-key`, no prefix. Holds the $10-limit test key |
| Service `httpbin-demo` | host `httpbin.org`, `Authorization: Bearer agentbox-demo-secret-that-the-agent-never-sees`. For the "the agent never sees it" demo |
| Machine identity | `agentbox-orchestrator`, org role no-access, Universal Auth, Agent Vault role member, granted bundle `agentbox`. Client id/secret live only in `~/agentbox/.env` on mini2 |

Every session the orchestrator mints shows up on Agent Vault's **Sessions** page with actor `agentbox-orchestrator`, and is revoked when the agentbox session ends.

### The two-line demo

```bash
# from a box: no internet without the proxy
docker exec <box> curl -m5 https://httpbin.org/get                          # fails
# with an Agent Vault session: the box sends a placeholder, httpbin sees the real secret
docker exec -e HTTPS_PROXY=http://x-agent-vault:<token>@av-relay:17323 <box> \
  curl -s -H "Authorization: Bearer placeholder" https://httpbin.org/headers
```

## Remaining

1. Optional: add `GITHUB_TOKEN=...` (repo scope on the demo repo) to `~/agentbox/.env` on mini2 and restart the orchestrator, so sessions end in real PRs. Without it the diff is stored in the session's events.
2. Optional: the orchestrator restarts itself after a crash (`bin/run-orchestrator`), but not after a mini2 reboot. A launchd agent would fix that.
3. **Come back to:** move secrets out of `~/agentbox/.env`. Replace the GitHub PAT with a GitHub App (per-session installation tokens, private key stored in Infisical), and have the orchestrator fetch its other secrets from Infisical with its machine identity at startup.
4. Next: the Slack bot, calling `POST /sessions` and following `/events`.
