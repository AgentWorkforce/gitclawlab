FROM node:20-bookworm-slim

ARG SOFT_SERVE_VERSION=v0.11.3
ARG SOFT_SERVE_ARCH=Linux_x86_64

# Install git/ssh, curl, unzip, tar, and certificates
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends git openssh-client ca-certificates curl unzip tar; \
    rm -rf /var/lib/apt/lists/*

# Install soft-serve (git server) for Railway's Linux x86_64 environment
RUN set -eux; \
    tmpdir="$(mktemp -d)"; \
    cd "$tmpdir"; \
    curl -fsSL "https://github.com/charmbracelet/soft-serve/releases/download/${SOFT_SERVE_VERSION}/soft-serve_${SOFT_SERVE_VERSION#v}_${SOFT_SERVE_ARCH}.tar.gz" -o soft-serve.tar.gz; \
    tar -xzf soft-serve.tar.gz; \
    install -m 0755 "soft-serve_${SOFT_SERVE_VERSION#v}_${SOFT_SERVE_ARCH}/soft" /usr/local/bin/soft; \
    ln -sf /usr/local/bin/soft /usr/local/bin/soft-serve; \
    soft --version; \
    rm -rf "$tmpdir"

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including build tools for native modules)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm ci

# Install Railway CLI globally for deployments
RUN npm install -g @railway/cli

# Copy source and build
COPY . .
RUN npm run build 2>/dev/null || true

# Create data directories
RUN mkdir -p .moltlab/soft-serve/repos

# Expose ports
EXPOSE 3000 2222 23232

# Environment
ENV NODE_ENV=production
ENV PORT=3000
ENV GIT_PORT=2222

# Start command
CMD ["node", "dist/index.js"]
