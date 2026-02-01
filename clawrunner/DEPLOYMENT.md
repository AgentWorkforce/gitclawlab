# ClawRunner Deployment Guide

## Fly.io Secrets Configuration

Before deploying ClawRunner to Fly.io, you must set the following secrets:

### Required Secrets

```bash
# Set all required secrets at once
fly secrets set \
  DATABASE_URL="postgres://user:password@host:5432/clawrunner?sslmode=require" \
  NANGO_SECRET_KEY="your-nango-secret-key" \
  FLY_API_TOKEN="your-fly-api-token"
```

#### DATABASE_URL
PostgreSQL connection string for the ClawRunner database.

- **Format**: `postgres://user:password@host:port/database?sslmode=require`
- **Required**: Yes
- **How to get**:
  - Use `fly postgres create` to create a Fly Postgres database
  - Or connect to an external PostgreSQL provider (e.g., Neon, Supabase)

```bash
fly secrets set DATABASE_URL="postgres://user:pass@db.example.com:5432/clawrunner?sslmode=require"
```

#### NANGO_SECRET_KEY
Secret key for Nango OAuth service API access.

- **Required**: Yes
- **How to get**:
  1. Go to [Nango Dashboard](https://app.nango.dev)
  2. Navigate to Project Settings > API Keys
  3. Copy the Secret Key

```bash
fly secrets set NANGO_SECRET_KEY="your-nango-secret-key"
```

#### FLY_API_TOKEN
Fly.io API token for machine management operations.

- **Required**: Yes (in production)
- **How to get**:
  1. Go to [Fly.io Personal Access Tokens](https://fly.io/user/personal_access_tokens)
  2. Create a new token with appropriate permissions
  3. Copy the token (it won't be shown again)

```bash
fly secrets set FLY_API_TOKEN="your-fly-api-token"
```

### Optional Secrets

#### NANGO_HOST
Custom Nango host URL (only for self-hosted Nango instances).

- **Required**: No
- **Default**: Uses Nango's cloud service

```bash
fly secrets set NANGO_HOST="https://your-nango-instance.com"
```

### Verifying Secrets

List all configured secrets:
```bash
fly secrets list
```

### Removing Secrets

```bash
fly secrets unset SECRET_NAME
```

## Environment Variables Set by Fly.io

These are automatically set by Fly.io and don't need manual configuration:

| Variable | Description |
|----------|-------------|
| `FLY_APP_NAME` | Name of the Fly app |
| `FLY_REGION` | Region where the machine is running |
| `FLY_MACHINE_ID` | ID of the current machine |
| `PORT` | Port to listen on (set to 8080) |

## Deployment Commands

```bash
# Deploy the application
fly deploy

# Check deployment status
fly status

# View logs
fly logs

# SSH into the machine
fly ssh console
```

## Database Migrations

Run migrations after deployment:
```bash
fly ssh console -C "npm run db:migrate"
```

## Health Check

The application exposes a health endpoint at `/health` that returns:
```json
{"status": "ok"}
```

Fly.io uses this for health checks and automatic restarts.
