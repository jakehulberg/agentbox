# agentbox golden image: what every warm-pool box starts from.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git curl ca-certificates jq ripgrep python3 python3-pip make procps less \
 && rm -rf /var/lib/apt/lists/*

# Claude Code, pinned at build time so every box runs the same version.
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

# Agent Vault proxy CA, baked in so TLS through the proxy just works.
COPY agent-vault-ca.pem /usr/local/share/ca-certificates/agent-vault.crt
RUN update-ca-certificates

ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/agent-vault.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt \
    NODE_USE_ENV_PROXY=1 \
    NO_PROXY=localhost,127.0.0.1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_AUTOUPDATER=1 \
    IS_SANDBOX=1

# Non-root user; the orchestrator bind-mounts the session's repo at /workspace.
RUN useradd -m -u 1001 -s /bin/bash agent && mkdir -p /workspace && chown agent:agent /workspace
USER agent
WORKDIR /workspace
RUN git config --global user.name "agentbox" && git config --global user.email "agentbox@localhost" \
 && git config --global --add safe.directory /workspace

LABEL org.agentbox.role=golden
CMD ["sleep", "infinity"]
