#!/bin/bash

# Development startup script for Mines AI Commons
# Usage: ./dev.sh

set -e

# Source nvm if available
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

PROJECT_DIR="."

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

# Check .env
check_env() {
    if [ ! -f "$PROJECT_DIR/.env" ]; then
        if [ -f "$PROJECT_DIR/.env.example" ]; then
            cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
            log_warn "Created .env from .env.example - please add your API keys"
        fi
    fi
}

# Start Docker services (postgres)
start_docker_services() {
    cd "$PROJECT_DIR"

    # Start postgres
    if ! docker ps | grep -q mines-ai-postgres; then
        log_info "Starting PostgreSQL..."
        docker compose up -d postgres 2>/dev/null || docker-compose up -d postgres
        log_info "Waiting for PostgreSQL..."
        until docker exec mines-ai-postgres pg_isready -U mines_ai -d mines_ai &>/dev/null; do
            sleep 1
        done
    fi
    log_success "PostgreSQL running on port 5435"
}

# Install deps if needed
install_deps() {
    if [ ! -d "$PROJECT_DIR/node_modules" ]; then
        log_info "Installing backend deps..."
        cd "$PROJECT_DIR" && npm install
    fi
}

# Cleanup on exit
cleanup() {
    log_info "Shutting down..."
    pkill -f "tsx watch" 2>/dev/null || true
    exit 0
}

# Get machine IP for network access
get_ip() {
    hostname -I | awk '{print $1}'
}

# Main
main() {
    trap cleanup SIGINT SIGTERM

    check_env
    start_docker_services
    install_deps

    IP=$(get_ip)
    echo ""
    log_success "All services ready!"
    echo ""
    echo "  API:            http://$IP:3002"
    echo "  Postgres:       localhost:5435"
    echo ""

    cd "$PROJECT_DIR"
    PORT=3002 npm run dev
}

main "$@"
