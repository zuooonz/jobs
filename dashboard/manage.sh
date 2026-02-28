#!/bin/bash

# =================================================================
# Job Dashboard Service Manager (CONDA-STABILITY VERSION)
# =================================================================

# Configuration
DASHBOARD_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT_DIR="$(dirname "$DASHBOARD_ROOT")"

# Load environment variables from root .env if it exists
if [ -f "$PARENT_DIR/.env" ]; then
    export $(grep -v '^#' "$PARENT_DIR/.env" | xargs)
fi

BACKEND_DIR="$DASHBOARD_ROOT/backend"
FRONTEND_DIR="$DASHBOARD_ROOT/frontend"
CONDA_ENV="ai_core"
BACKEND_PORT="${BACKEND_PORT:-8888}"
FRONTEND_PORT="${FRONTEND_PORT:-5175}"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' 

function check_status() {
    local backend_pid=$(lsof -t -i:$BACKEND_PORT)
    local frontend_pid=$(lsof -t -i:$FRONTEND_PORT)

    echo -e "${YELLOW}--- Service Status ---${NC}"
    if [ -n "$backend_pid" ]; then
        echo -e "Backend (FastAPI): ${GREEN}RUNNING${NC} (PID: $backend_pid)"
    else
        echo -e "Backend (FastAPI): ${RED}STOPPED${NC}"
    fi

    if [ -n "$frontend_pid" ]; then
        echo -e "Frontend (Vite):    ${GREEN}RUNNING${NC} (PID: $frontend_pid)"
    else
        echo -e "Frontend (Vite):    ${RED}STOPPED${NC}"
    fi
    echo -e "${YELLOW}----------------------${NC}"
}

function stop_services() {
    echo "Stopping services..."
    
    # Kill backend
    fuser -k $BACKEND_PORT/tcp >/dev/null 2>&1
    
    # Kill frontend
    fuser -k $FRONTEND_PORT/tcp >/dev/null 2>&1

    # Backup cleanup
    pkill -f "main.py" 2>/dev/null
    
    echo -e "${GREEN}Cleanup complete.${NC}"
}

function start_services() {
    echo "Starting services..."

    # Ensure clean slate
    stop_services

    # 1. Start Backend with CONDA
    echo "Activating Conda environment: $CONDA_ENV..."
    
    # Determine conda path safely
    CONDA_PATH=$(which conda)
    if [ -z "$CONDA_PATH" ]; then
        CONDA_PATH="$HOME/miniconda3/bin/conda"
    fi
    
    CONDA_BASE=$(dirname $(dirname "$CONDA_PATH"))
    if [ -f "$CONDA_BASE/etc/profile.d/conda.sh" ]; then
        source "$CONDA_BASE/etc/profile.d/conda.sh"
    fi
    
    # Try to activate
    conda activate "$CONDA_ENV" 2>/dev/null || {
        echo -e "${RED}Error: Failed to activate conda environment '$CONDA_ENV'.${NC}"
        echo "Please ensure conda is installed and '$CONDA_ENV' environment exists."
        exit 1
    }

    echo "Starting Backend API..."
    cd "$BACKEND_DIR"
    nohup python3 -u main.py > /tmp/dashboard_backend.log 2>&1 &
    
    # Wait for backend to be ready
    echo -n "Waiting for Backend to stabilize..."
    for i in {1..15}; do
        if curl -s "http://localhost:$BACKEND_PORT/" > /dev/null; then
            echo -e " [${GREEN}OK${NC}]"
            break
        fi
        echo -n "."
        sleep 1
        if [ $i -eq 15 ]; then
            echo -e " [${RED}FAILED${NC}]"
            echo "Check /tmp/dashboard_backend.log for errors."
        fi
    done

    # 2. Start Frontend
    echo "Starting Frontend Dashboard..."
    cd "$FRONTEND_DIR"
    nohup npm run dev -- --port $FRONTEND_PORT > /tmp/dashboard_frontend.log 2>&1 &
    
    # Wait for frontend
    sleep 2
    if lsof -i:$FRONTEND_PORT >/dev/null; then
        echo -e "Frontend: [${GREEN}OK${NC}]"
    else
         echo -e "Frontend: [${RED}FAILED${NC}]"
    fi

    echo -e "\n${GREEN}Dashboard is ready at: http://localhost:$FRONTEND_PORT${NC}"
    check_status
}

case "$1" in
    start)
        start_services
        ;;
    stop)
        stop_services
        ;;
    restart)
        stop_services
        start_services
        ;;
    status)
        check_status
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status}"
        exit 1
esac
