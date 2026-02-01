#!/bin/sh
# ClawRunner Container Entrypoint
# Handles configuration processing and application startup

set -e

# Configuration
CONFIG_FILE="${CONFIG_FILE:-/app/config/config.json}"
SECRETS_DIR="${SECRETS_DIR:-/run/secrets}"

log() {
    echo "[entrypoint] $(date -Iseconds) $*"
}

error() {
    echo "[entrypoint] $(date -Iseconds) ERROR: $*" >&2
}

# Process configuration with jq if config file exists
process_config() {
    if [ -f "$CONFIG_FILE" ]; then
        log "Processing configuration from $CONFIG_FILE"

        # Validate JSON syntax
        if ! jq empty "$CONFIG_FILE" 2>/dev/null; then
            error "Invalid JSON in $CONFIG_FILE"
            exit 1
        fi

        # Inject secrets from environment if available
        if [ -n "$DATABASE_URL" ]; then
            log "Injecting DATABASE_URL into config"
            TEMP_CONFIG=$(mktemp)
            jq --arg db "$DATABASE_URL" '.database.url = $db' "$CONFIG_FILE" > "$TEMP_CONFIG" && \
                mv "$TEMP_CONFIG" "$CONFIG_FILE" 2>/dev/null || \
                log "Note: Could not update config file (read-only), using env var"
        fi

        # Load secrets from mounted files (Docker secrets or Kubernetes secrets)
        if [ -d "$SECRETS_DIR" ]; then
            log "Loading secrets from $SECRETS_DIR"
            for secret_file in "$SECRETS_DIR"/*; do
                if [ -f "$secret_file" ]; then
                    secret_name=$(basename "$secret_file" | tr '[:lower:]' '[:upper:]' | tr '-' '_')
                    secret_value=$(cat "$secret_file")
                    export "$secret_name"="$secret_value"
                    log "Loaded secret: $secret_name"
                fi
            done
        fi
    else
        log "No config file found at $CONFIG_FILE, using environment variables"
    fi
}

# Validate required environment variables
validate_env() {
    log "Validating environment configuration"

    # Check for required variables (add more as needed)
    if [ -z "$PORT" ]; then
        export PORT=3000
        log "PORT not set, defaulting to 3000"
    fi

    # Warn about missing optional but recommended variables
    if [ -z "$NODE_ENV" ]; then
        export NODE_ENV=production
        log "NODE_ENV not set, defaulting to production"
    fi

    log "Environment validation complete"
}

# Health check function (can be called manually)
health_check() {
    wget --no-verbose --tries=1 --spider "http://localhost:${PORT}/health" 2>/dev/null
}

# Graceful shutdown handler
shutdown() {
    log "Received shutdown signal, gracefully stopping..."
    kill -TERM "$NODE_PID" 2>/dev/null
    wait "$NODE_PID"
    log "Shutdown complete"
    exit 0
}

# Main execution
main() {
    log "Starting ClawRunner container"
    log "Node.js version: $(node --version)"
    log "Working directory: $(pwd)"

    # Process configuration
    process_config

    # Validate environment
    validate_env

    # Set up signal handlers for graceful shutdown
    trap shutdown SIGTERM SIGINT SIGQUIT

    log "Starting Node.js application on port $PORT"

    # Start the application
    # Run in background to properly handle signals
    node dist/index.js &
    NODE_PID=$!

    log "Application started with PID $NODE_PID"

    # Wait for the application
    wait "$NODE_PID"
    EXIT_CODE=$?

    log "Application exited with code $EXIT_CODE"
    exit $EXIT_CODE
}

# Allow running specific commands
case "${1:-}" in
    health)
        health_check
        ;;
    shell)
        exec /bin/sh
        ;;
    *)
        main "$@"
        ;;
esac
