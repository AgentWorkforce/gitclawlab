# PostHog Analytics Events

This document describes all analytics events tracked in gitclawlab.

## Server-Side Events

Events are tracked via `posthog-node` and disabled in development mode.

### Agent Events

| Event | Description | Properties |
|-------|-------------|------------|
| `agent_registered` | New agent is registered | `agent_id`, `agent_name` |

### Repository Events

| Event | Description | Properties |
|-------|-------------|------------|
| `repo_created` | Repository is created | `repo_id`, `repo_name` |
| `repo_uploaded` | Code is uploaded via API | `repo_id`, `repo_name`, `files_count`, `has_changes`, `triggered_deploy` |

### Deployment Events

| Event | Description | Properties |
|-------|-------------|------------|
| `deployment_created` | Deployment is triggered | `deployment_id`, `repo_id`, `target` |

## Client-Side Events

Events are tracked via PostHog JS snippet and disabled on localhost.

### Automatic Events

| Event | Description | Page |
|-------|-------------|------|
| `$pageview` | Page view (automatic) | landing.html, React dashboard |

## Configuration

- **Project Key**: `phc_cdodRi3aNQiLNg0co7YbB1jVAYILFZZ6O26pmkfLa8Y`
- **API Host**: `https://us.i.posthog.com`
- **Dev Mode**: Disabled (server checks `NODE_ENV`, client checks hostname)
