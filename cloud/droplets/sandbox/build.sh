# Rebuild the repo image from the latest main. Run by cron every 30 min; new boxes use :latest.
set -e
exec 9>/var/lock/agentbox-build.lock; flock -n 9 || exit 0
cd /opt/agentbox/golden && docker build -q -t agentbox/golden:latest . >/dev/null
cd /opt/agentbox/mirror/infisical2 && git fetch -q origin main && git reset -q --hard origin/main
SHA=$(git rev-parse --short HEAD)
if docker image inspect agentbox/infisical2:$SHA >/dev/null 2>&1; then echo "$(date -Is) up to date at $SHA"; exit 0; fi
cd /opt/agentbox/mirror && docker build -q -f Dockerfile.repo -t agentbox/infisical2:$SHA -t agentbox/infisical2:latest . >/dev/null
echo "$(date -Is) built agentbox/infisical2:$SHA"
docker images agentbox/infisical2 --format "{{.Tag}}" | grep -v latest | tail -n +4 | xargs -r -I{} docker rmi agentbox/infisical2:{} >/dev/null 2>&1 || true
docker image prune -f >/dev/null
