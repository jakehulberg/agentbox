# agentbox

A reference architecture for background coding agents: you run `agentbox run "task"`, Claude Code works in an isolated sandbox, and the change comes back as a pull request. The agent never holds a real credential. Every call it makes goes through the [Infisical Agent Vault](https://infisical.com) proxy, which attaches the credential after the request has left the sandbox.

There are two builds of the same design:

| Folder | What it runs on | Start here |
|---|---|---|
| [`cloud/`](cloud) | Cloudflare Workers + Durable Objects for the API and session state, DigitalOcean droplets for the sandboxes and the Agent Vault proxy, Infisical Cloud | [cloud/ARCHITECTURE.md](cloud/ARCHITECTURE.md) |
| [`local/`](local) | Two Mac minis: a Node orchestrator with a warm pool of Docker sandboxes in a Colima VM, self-hosted Infisical, Tailscale between them | [local/ARCHITECTURE.md](local/ARCHITECTURE.md) |

`local/` came first; each doc in `cloud/docs/` says which piece of the local build it replaces.

IPs, domains and account IDs in the docs are examples or placeholders. Secrets are never in the repo: the local build reads them from `~/agentbox/.env`, and the cloud build uses `wrangler secret put` (see [cloud/worker/wrangler.toml](cloud/worker/wrangler.toml)).
