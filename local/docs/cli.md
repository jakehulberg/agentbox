# CLI

`bin/agentbox` is how a person talks to the platform. It's a single Node script with no dependencies, a thin client over the orchestrator's HTTP API. It has no logic of its own: a Slack bot or web UI would make the same calls.

It plays the role of Ramp's clients (their web UI, Slack bot and Chrome extension).

## Setup

```bash
export AGENTBOX_URL=http://100.124.121.114:8787          # the orchestrator on mini2, over Tailscale
export ORCH_API_TOKEN=$(ssh mini2 "grep ^ORCH_API_TOKEN ~/agentbox/.env | cut -d= -f2")
alias agentbox=~/Documents/GitHub/agentbox/local/bin/agentbox
# optional: export AGENTBOX_REPO=owner/repo   (default jakehulberg2/demo-app)
```

On mini2 itself none of this is needed: it reads `~/agentbox/.env`.

## Commands

| Command | Does |
|---|---|
| `agentbox run` | Opens a chat in the default repo. Type your first message at `›` |
| `agentbox run "task"` | Same, starting with that task |
| `agentbox run owner/repo ["task"]` | Another repo |
| `agentbox attach <id>` | Reopen a session. If it's working you watch it live; if it's idle or asleep you get the prompt |
| `agentbox ls` | Recent sessions: status, age, PR number, cost, repo, prompt |
| `agentbox logs <id>` | Replay a session's whole history |
| `agentbox send <id> "msg"` | One-off follow-up without the chat |
| `agentbox pool` | The boxes and their state |
| `agentbox cancel <id>` | Cancel |
| `--verbose` | Also show plumbing (Agent Vault revokes, stderr, raw event types) |
| `--detach` | (`run`) queue and exit |

## In a chat

| Key | |
|---|---|
| type + enter | Send a follow-up. Instant if the box is parked, a few seconds if the session was asleep |
| ctrl-d / `exit` | Leave. The session stays; `agentbox attach <id>` brings it back |
| ctrl-c while working | Detach. The agent keeps going |
| `/cancel` | Kill the session |

## What the output means

```
◆ agentbox  jakehulberg2/demo-app · s-64102cee
› do a quick security review of the CSV export             your message
  ◇ claimed box-a8d15d · 172.30.0.5 · … → agentbox/s-…      which sandbox, and the PR branch
  ⚿ Agent Vault session 9766e050 · bundle agentbox · …      this turn's credential grant
  ⠹ Thinking… 4s · ctrl-c to detach                         the animation while Claude works
  ⏺ Bash cat src/exports/csv.ts                             a tool call
    ⎿ 6 lines                                               its result (red if it failed)
  ⏺ Edit src/exports/csv.ts

  I found two problems…                                     Claude's reply

  ✓ 7 steps · $0.061 this turn · 22s
  ± 1 file changed, 12 insertions(+), 3 deletions(-)
  ↗ opened https://github.com/jakehulberg2/demo-app/pull/38
  box parked for 15 min · replies resume instantly · ctrl-d to leave
›
```

`◇` says `claimed` for a new box, `resuming in` for the session's parked box, and `restored into` when a sleeping session wakes up in a fresh box.

## How it works

- `run` → `POST /sessions`, then streams `GET /sessions/:id/events` (server-sent events) and renders each event.
- When the stream ends (the session settled), it shows the `›` prompt. What you type goes to `POST /sessions/:id/messages`, and it streams again from that message's event.
- The animation is a spinner plus a verb with a light sweeping across it, redrawn every 80 ms, only when the output is a terminal.
- Each turn's cost is computed from Claude's running total, because Claude reports cost cumulatively across a resumed conversation.
