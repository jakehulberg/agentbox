# Droplet setup

Everything that runs on the two DigitalOcean droplets, copied from the live machines, so they can be rebuilt from this repo. No secrets are in here: the three env files below are written from your Infisical keys project.

| Droplet | Size | Addresses | Firewall (inbound) |
|---|---|---|---|
| `agentbox-sandbox` | `s-4vcpu-8gb`, Ubuntu 24.04, nyc3 | 203.0.113.10 · VPC 10.60.0.3 | 22 from your IP only |
| `agentbox-proxy` | `s-1vcpu-1gb`, Ubuntu 24.04, nyc3 | 203.0.113.20 · VPC 10.60.0.2 | 22 from your IP · 17323 from 10.60.0.0/20 |

Both on VPC `agentbox` (10.60.0.0/20). Both droplets were created with cloud-init installing `docker.io`, `git`, `jq`.

## Files

| File | Goes to (sandbox droplet) | What |
|---|---|---|
| [sandbox/golden/Dockerfile](sandbox/golden/Dockerfile) | `/opt/agentbox/golden/Dockerfile` | Base image: Node 22, git, Claude Code, non-root `agent`, trusts the proxy CA |
| [sandbox/golden/agent-vault-ca.pem](sandbox/golden/agent-vault-ca.pem) | `/opt/agentbox/golden/agent-vault-ca.pem` | `do-proxy`'s CA certificate (public; no key) |
| [sandbox/image/Dockerfile.repo](sandbox/image/Dockerfile.repo) | `/opt/agentbox/mirror/Dockerfile.repo` | Repo image: golden + build tools + `npm ci` (cached on lockfiles) + the fork at `/workspace` |
| [sandbox/image/.dockerignore](sandbox/image/.dockerignore) | `/opt/agentbox/mirror/.dockerignore` | Keeps any local `node_modules` out of the build |
| [sandbox/build.sh](sandbox/build.sh) | `/opt/agentbox/build.sh` | Fetch the fork's `main`, build `agentbox/infisical2:<sha>` + `:latest` if new, keep last 3 |
| [sandbox/agentbox-build.cron](sandbox/agentbox-build.cron) | `/etc/cron.d/agentbox-build` | Run `build.sh` every 30 min |
| [sandbox/boxd.service](sandbox/boxd.service) | `/etc/systemd/system/boxd.service` | Runs [../boxd/server.mjs](../boxd/server.mjs) (copied to `/opt/agentbox/boxd.mjs`) |
| [sandbox/containers.sh](sandbox/containers.sh) | run once | `agentnet`, `av-relay`, `cloudflared` |
| [proxy/proxy.sh](proxy/proxy.sh) | proxy droplet, run once | Enroll and run the Agent Vault proxy |

## Env files (written from Infisical, mode 600, never committed)

| File | Contents | From |
|---|---|---|
| `/etc/agentbox/boxd.env` (sandbox) | `BOXD_TOKEN=…`, `MAX_BOXES=3` | `BOXD_TOKEN` |
| `/etc/agentbox/cloudflared.env` (sandbox) | `TUNNEL_TOKEN=…` | `CF_TUNNEL_TOKEN` |
| proxy volume `agent-vault-proxy` | Proxy identity + CA, created by enrollment | `AV_PROXY_ENROLLMENT_TOKEN` (one-time) |

## Rebuild from scratch

```bash
# proxy droplet
./proxy.sh enroll avp_...                       # new enrollment token from Infisical -> new CA
# copy the new CA into sandbox/golden/agent-vault-ca.pem (command at the end of proxy.sh)

# sandbox droplet
apt-get install -y nodejs                       # boxd runs on the host (Ubuntu's Node 18 is fine)
mkdir -p /opt/agentbox/golden /opt/agentbox/mirror /etc/agentbox
# copy the files above into place, and ../boxd/server.mjs to /opt/agentbox/boxd.mjs
git clone https://github.com/jakehulberg2/infisical2.git /opt/agentbox/mirror/infisical2
# write /etc/agentbox/boxd.env and /etc/agentbox/cloudflared.env from Infisical (mode 600)
bash /opt/agentbox/build.sh                     # first build: ~10-12 min
systemctl daemon-reload && systemctl enable --now boxd
bash containers.sh
```

Then check: `curl` to `https://boxd.example.com/healthz` without the Access service token gets 403, and with it gets `{"ok":true}`.
