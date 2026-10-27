# agentbox cloud docs

The production-style version of agentbox: Cloudflare Durable Objects for sessions, a DigitalOcean droplet for sandboxes, and Infisical Agent Vault (Cloud) for credentials, with its proxy on a second droplet. Start with [../ARCHITECTURE.md](../ARCHITECTURE.md), or open [../architecture.excalidraw](../architecture.excalidraw), which has one frame per doc below.

| Doc | Component | One line |
|---|---|---|
| [cli.md](cli.md) | `agentbox` CLI | Logs in with GitHub, talks to the Worker, streams over a WebSocket |
| [api-and-durable-objects.md](api-and-durable-objects.md) | API Worker + Session DO | One Durable Object per session runs every turn from its alarm |
| [state.md](state.md) | DO SQLite, D1 | What's recorded, where, and who can read it |
| [sandbox-host.md](sandbox-host.md) | Sandbox droplet, boxd, repo image | Boxes that start with the Infisical repo and its deps already inside |
| [networking.md](networking.md) | agentnet, relay, VPC, firewalls | Why a box can only reach the Agent Vault proxy |
| [agent-vault.md](agent-vault.md) | Proxy, bundles, services, grants | How the agent uses Anthropic and GitHub without holding a key |
| [git-and-github.md](git-and-github.md) | Commit, push, PR | How code gets back out as a PR |
| [security.md](security.md) | Trust zones and threats | What each part can reach and what happens if it's compromised |

Code: [../worker](../worker) (Worker + DO), [../boxd](../boxd) (box API), [../cli](../cli) (CLI), [../droplets](../droplets) (everything on the two droplets).
