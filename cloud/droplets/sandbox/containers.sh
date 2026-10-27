#!/usr/bin/env bash
# Long-running containers on agentbox-sandbox: the internal network, the relay to the proxy, and the tunnel.
# Boxes themselves are created by boxd, not here. Run as root on the droplet.
set -euo pipefail

# agentnet: no gateway, no outside DNS. Boxes live here and can only reach av-relay.
docker network inspect agentnet >/dev/null 2>&1 || docker network create --internal --subnet 172.30.0.0/24 agentnet

# av-relay: the one hole. Forwards only :17323 to the Agent Vault proxy over the VPC.
docker rm -f av-relay >/dev/null 2>&1 || true
docker run -d --name av-relay --restart unless-stopped --network agentnet --ip 172.30.0.2 \
  alpine/socat -d tcp-listen:17323,fork,reuseaddr tcp:10.60.0.2:17323
docker network connect bridge av-relay

# cloudflared: opens the Cloudflare Tunnel outbound, so boxd (127.0.0.1:8788) needs no public port.
# /etc/agentbox/cloudflared.env holds TUNNEL_TOKEN=<CF_TUNNEL_TOKEN from Infisical>, mode 600.
docker rm -f cloudflared >/dev/null 2>&1 || true
docker run -d --name cloudflared --restart unless-stopped --network host \
  --env-file /etc/agentbox/cloudflared.env cloudflare/cloudflared:2026.9.1 tunnel --no-autoupdate run
