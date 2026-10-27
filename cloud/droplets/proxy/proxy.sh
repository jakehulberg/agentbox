#!/usr/bin/env bash
# The Agent Vault proxy on agentbox-proxy. Run as root on the droplet.
#   ./proxy.sh enroll <avp_...>   first time only: trade the one-time enrollment token for the proxy's identity + CA
#   ./proxy.sh                    run it (VPC address only; the firewall allows 17323 only from 10.60.0.0/20)
# The enrollment token comes from Infisical Cloud: Agent Vault -> Proxies -> do-proxy.
set -euo pipefail
IMAGE=infisical/cli:0.43.137
docker volume create agent-vault-proxy >/dev/null

if [ "${1:-}" = enroll ]; then
  docker rm -f av-enroll >/dev/null 2>&1 || true
  docker run -d --name av-enroll -v agent-vault-proxy:/data $IMAGE \
    agent-vault proxy --data-dir /data --enrollment-token "$2" --log-format json
  until docker logs av-enroll 2>&1 | grep -qiE 'listening|error'; do sleep 1; done
  docker logs av-enroll 2>&1 | tail -2
  docker rm -f av-enroll >/dev/null
fi

docker rm -f agent-vault-proxy >/dev/null 2>&1 || true
docker run -d --name agent-vault-proxy --restart unless-stopped -p 10.60.0.2:17323:17323 \
  -v agent-vault-proxy:/data $IMAGE agent-vault proxy --data-dir /data --log-format json

# The golden image must trust this proxy's CA. After a (re)enrollment, refresh it from a box host:
#   curl -s http://10.60.0.2:17323/_agent-vault/ca | jq -r .certificate > ../sandbox/golden/agent-vault-ca.pem
