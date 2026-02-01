# ClawRunner Docker Build Guide

## Overview

This document describes how to build and run the ClawRunner Docker image for local development and production deployments.

## Files

- `Dockerfile.openclaw` - Multi-stage Dockerfile with security hardening
- `entrypoint.sh` - Container entrypoint script with config processing
- `docker-compose.yml` - Local testing configuration

## Security Features

The Docker image includes the following security hardening measures:

1. **Non-root user**: Runs as `clawrunner` user (UID 1001) instead of root
2. **Minimal base image**: Uses `node:20-alpine` for smallest attack surface
3. **Production dependencies only**: Dev dependencies excluded from final image
4. **Read-only filesystem**: Configurable via docker-compose
5. **Dropped capabilities**: All Linux capabilities dropped by default
6. **No new privileges**: Prevents privilege escalation
7. **Health checks**: Built-in health monitoring
8. **Signal handling**: Proper SIGTERM handling via dumb-init

## Installed Packages

- `jq` - JSON processing for configuration manipulation
- `dumb-init` - Proper init system for signal handling
- `ca-certificates` - HTTPS certificate validation

## Building the Image

### Local Build

```bash
# From project root
docker build -f docker/Dockerfile.openclaw -t clawrunner:local .

# With specific tag
docker build -f docker/Dockerfile.openclaw -t clawrunner:v1.0.0 .

# For specific platform
docker build -f docker/Dockerfile.openclaw --platform linux/amd64 -t clawrunner:amd64 .
```

### Using Docker Compose

```bash
# Build and start
docker-compose -f docker/docker-compose.yml up --build

# Build only
docker-compose -f docker/docker-compose.yml build

# Development mode with hot reload
docker-compose -f docker/docker-compose.yml --profile dev up clawrunner-dev
```

## Running the Container

### Basic Run

```bash
docker run -p 3000:3000 clawrunner:local
```

### With Environment Variables

```bash
docker run -p 3000:3000 \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e DATABASE_URL="postgres://..." \
  -e NANGO_SECRET_KEY="sk_..." \
  clawrunner:local
```

### With Configuration File

```bash
docker run -p 3000:3000 \
  -v $(pwd)/config:/app/config:ro \
  -e CONFIG_FILE=/app/config/config.json \
  clawrunner:local
```

### With Docker Secrets (Production)

```bash
# Create secrets
echo "your-db-url" | docker secret create database_url -
echo "your-nango-key" | docker secret create nango_secret_key -

# Run with secrets
docker service create \
  --name clawrunner \
  --secret database_url \
  --secret nango_secret_key \
  -p 3000:3000 \
  clawrunner:local
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | HTTP server port |
| `NODE_ENV` | No | `production` | Node environment |
| `DATABASE_URL` | No | - | PostgreSQL connection URL |
| `NANGO_SECRET_KEY` | No | - | Nango secret API key |
| `NANGO_PUBLIC_KEY` | No | - | Nango public API key |
| `CONFIG_FILE` | No | `/app/config/config.json` | Path to JSON config |
| `SECRETS_DIR` | No | `/run/secrets` | Directory for Docker secrets |

## Health Check

The container exposes a health endpoint:

```bash
# Check health
curl http://localhost:3000/health

# Response: {"status":"ok"}
```

Docker health check runs every 30 seconds with 10s timeout.

## Entrypoint Commands

The entrypoint script supports special commands:

```bash
# Run health check manually
docker run clawrunner:local health

# Get a shell (debugging)
docker run -it clawrunner:local shell
```

## Configuration Processing

The entrypoint script supports JSON configuration with jq:

1. Place a `config.json` in the mounted config volume
2. Set `CONFIG_FILE=/app/config/config.json`
3. Environment variables like `DATABASE_URL` will be injected into the config
4. Docker secrets from `SECRETS_DIR` are automatically loaded as environment variables

## Troubleshooting

### Container won't start

```bash
# Check logs
docker logs clawrunner

# Run with verbose output
docker run -e DEBUG=1 clawrunner:local
```

### Permission denied errors

The container runs as non-root. Ensure mounted volumes are readable:

```bash
chmod -R 755 ./config
```

### Health check failing

1. Verify the application is running: `docker exec clawrunner ps aux`
2. Check if port is accessible: `docker exec clawrunner wget -q -O- http://localhost:3000/health`
3. Review logs: `docker logs clawrunner`

## Production Deployment

For production deployments:

1. Use specific version tags, not `latest`
2. Enable read-only filesystem via docker-compose
3. Use Docker secrets for sensitive data
4. Configure resource limits (memory, CPU)
5. Set up log aggregation
6. Enable container scanning in CI/CD

Example production docker-compose override:

```yaml
services:
  clawrunner:
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '0.5'
        reservations:
          memory: 256M
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```
