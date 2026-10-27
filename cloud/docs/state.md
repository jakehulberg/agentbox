# State: DO SQLite and D1

Replaces: `~/agentbox/state/agentbox.db` on mini2 (see [agentbox sqlite.md](../../local/docs/sqlite.md)).

agentbox kept every session in one SQLite file. Here each session's Durable Object has its **own** SQLite database, so there's no `session_id` column: everything in that database belongs to one session. Only the cross-session list lives in a shared place (D1).

## Where each thing lives

| Data | Store | Written by | Read by |
|---|---|---|---|
| The session, its messages, turns, events | Session DO's SQLite | That DO only | That DO (API, WebSocket replay) |
| "My sessions" list | D1 `sessions_index` | Each DO, on every save | Worker for `GET /sessions` and ownership checks |
| Command output | Files on the sandbox droplet (`/var/lib/agentbox/execs`) | boxd | The DO, from its cursor |
| Repo, commits, Claude history | The box's container disk | The agent, `finish.sh` | Claude `--resume`, `finish.sh` |
| Grant mints, revokes, proxied requests | Infisical audit log | Infisical + proxy | You, joined by `turns.av_session_id` |

## Session DO tables

| Table | Columns |
|---|---|
| `session` | one row, JSON: `id`, `owner`, `repo`, `base_branch`, `branch`, `status`, `box`, `ip`, `claude_session_id`, `pr_url`, `cost_usd`, `num_turns`, `idle_since`, `retry_at`, timestamps |
| `messages` | `id`, `prompt`, `author`, `status` (`pending` / `running` / `done` / `failed`), `created_at`. Pending rows are the queue |
| `turns` | `id`, `message_id`, `phase` (`agent` / `finish`), `exec_id`, `log_next` (cursor), `av_session_id`, `av_finish_session_id`, `started_at`, `ended_at`, `result` |
| `events` | `seq`, `ts`, `kind` (`message` / `status` / `agent` / `log` / `error` / `result` / `pr`), `data` (JSON). `agent` rows are Claude's raw `stream-json` lines |

`status` goes `queued` → `starting` → `running` → `finishing` → `idle` → `sleeping`, or ends at `failed` / `cancelled`.

## D1: `sessions_index`

`id`, `owner`, `repo`, `prompt`, `status`, `pr_url`, `cost_usd`, `created_at`, `updated_at`, indexed on `(owner, updated_at)`. Schema: [../worker/schema.sql](../worker/schema.sql). It's a copy; the DO is the truth.
