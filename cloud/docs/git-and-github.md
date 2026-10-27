# Git and GitHub

Replaces: host-side mirrors, checkout, push and PR on mini2 (see [agentbox git-and-github.md](../../local/docs/git-and-github.md)).

On the minis the orchestrator did git on the host, because the repo folder was mounted from mini2. Here the repo lives inside the box, so git runs there, and the credentials still don't: the proxy attaches them.

## A session's git, start to finish

| Step | Where | Credential |
|---|---|---|
| Repo into the box | Baked into the image (≤30 min behind the fork's `main`) | None at session time |
| `git checkout -b agentbox/<id> origin/main` | DO runs it in the box | None |
| Agent edits, may commit | Box | None |
| Commit leftovers, push `agentbox/<id>`, open or update the PR | `finish.sh`, run by the DO after Claude exits | `finish` grant |

## `finish.sh`

Code: [../worker/src/finish.js](../worker/src/finish.js). The script is stored in the Worker and sent with each run, so nothing the agent did to the box can change it.

| Step | Detail |
|---|---|
| 1. Clean slate | The DO already ran `pkill -9 -u agent`, so nothing the agent left running sees the `finish` token |
| 2. Distrust the box | Fresh empty `HOME` (so `~/.gitconfig`, `~/.curlrc`, `~/.jq` aren't read), `GIT_CONFIG_NOSYSTEM=1`, `.git/config` rebuilt from scratch (drops `core.fsmonitor`, filter drivers, aliases, includes, url rewrites), hooks off, `.git` must be a real directory |
| 2b. Commit | `git add -A && commit` with those protections |
| 3. Check | No commits vs `origin/main`: `nochanges`. Branch already at HEAD: `nonew` (question-only turns don't touch the PR) |
| 4. Push | `HEAD:refs/heads/agentbox/<id>` through the proxy (`github-git`) |
| 5. PR | First push: `POST /repos/<repo>/pulls` with the prompt, the agent's summary and "requested by @owner". Later turns: the push already updated it |
| 6. Report | One JSON line per result; the DO records `pr` events |

Verified: [PR #1](https://github.com/jakehulberg2/infisical2/pull/1) opened on the first turn, updated on the follow-up.

## Still to do on GitHub

| Rule | Why |
|---|---|
| Ruleset: the bot can create and update only `agentbox/*` | The proxy can't see branch names inside a push; GitHub can |
| `main` protected: PR + review | Even a bad push can't land |
