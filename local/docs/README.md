# agentbox docs

A small version of Ramp's background agent on two Mac minis, with Infisical Agent Vault brokering credentials. Start with [../ARCHITECTURE.md](../ARCHITECTURE.md) for the whole picture, then one doc per component:

| Doc | Component | One line |
|---|---|---|
| [cli.md](cli.md) | `agentbox` CLI | How a person talks to it: `agentbox run`, chat, attach |
| [orchestrator.md](orchestrator.md) | Orchestrator on mini2 | Plain code that runs the same steps for every message |
| [sqlite.md](sqlite.md) | SQLite state | What's recorded, by whom, and why it matters |
| [warm-pool.md](warm-pool.md) | Boxes and the golden image | The sandboxes, how they start, live, sleep and die |
| [networking.md](networking.md) | Colima VM, agentnet, relay | Why a box can only reach the outside through Agent Vault |
| [agent-vault.md](agent-vault.md) | Agent Vault + Infisical on mini3 | How the agent calls Anthropic without holding the key |
| [git-and-github.md](git-and-github.md) | Mirrors, checkout, PRs | How code gets into the box and back out as a PR |
