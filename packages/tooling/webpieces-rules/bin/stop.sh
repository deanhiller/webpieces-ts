#!/bin/bash

# Stop script for webpieces-ts server
# Path-agnostic version that works from both workspace and node_modules

PID_FILE="/tmp/webpieces-ts-server.pid"

echo "Stopping webpieces-ts server..."

# Check if PID file exists
if [ ! -f "$PID_FILE" ]; then
    echo "⚠️  No PID file found. Server may not be running."
    echo "Checking for any running server processes..."

    # Try to find and kill any running server processes
    pkill -f "node -r reflect-metadata dist/apps/example-app/src/server.js"

    if [ $? -eq 0 ]; then
        echo "✅ Killed running server process(es)"
    else
        echo "❌ No running server found"
    fi

    exit 0
fi

# Read PID
SERVER_PID=$(cat "$PID_FILE")

# Check if process is running
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "⚠️  Process $SERVER_PID is not running (stale PID file)"
    rm -f "$PID_FILE"
    exit 0
fi

# Try graceful shutdown first (SIGTERM)
echo "Sending SIGTERM to process $SERVER_PID..."
kill "$SERVER_PID"

# Wait up to 10 seconds for graceful shutdown
for i in {1..10}; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        echo "✅ Server stopped gracefully"
        rm -f "$PID_FILE"
        exit 0
    fi
    sleep 1
done

# If still running, force kill (SIGKILL)
echo "⚠️  Server didn't stop gracefully, forcing shutdown..."
kill -9 "$SERVER_PID" 2>/dev/null

# Wait a bit more
sleep 1

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "✅ Server stopped (forced)"
    rm -f "$PID_FILE"
    exit 0
else
    echo "❌ Failed to stop server"
    exit 1
fi
