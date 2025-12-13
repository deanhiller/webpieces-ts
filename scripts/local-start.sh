#!/bin/bash

# Unified start script for webpieces-ts
# Usage:
#   ./scripts/local-start.sh server
#   ./scripts/local-start.sh client
#   ./scripts/local-start.sh stop-server
#   ./scripts/local-start.sh stop-client

SERVICE="$1"

if [ -z "$SERVICE" ]; then
    echo "Usage: $0 <server|client|stop-server|stop-client>"
    exit 1
fi

# Detect N from repo directory name (webpieces-ts{N})
# Examples: webpieces-ts → N=0, webpieces-ts1 → N=1
REPO_NAME=$(basename "$(pwd)")
if [[ $REPO_NAME =~ webpieces-ts([0-9]+)$ ]]; then
    N="${BASH_REMATCH[1]}"
else
    N=0  # Default to 0 if no number found
fi

# Calculate ports
CLIENT_PORT=$((4200 + N))
SERVER_PORT=$((8200 + N))

# Ensure we're in project root
cd "$(dirname "$0")/.." || exit 1

case "$SERVICE" in
    server)
        echo "Starting server on port ${SERVER_PORT} (N=${N})..."

        LOG_FILE="tmp/server.log"
        PID_FILE="/tmp/webpieces-ts-server-${N}.pid"

        # Check if already running
        if [ -f "$PID_FILE" ]; then
            if kill -0 $(cat "$PID_FILE") 2>/dev/null; then
                echo "❌ Server is already running (PID: $(cat $PID_FILE))"
                exit 1
            else
                echo "⚠️ Removing stale PID file"
                rm -f "$PID_FILE"
            fi
        fi

        if lsof -Pi :${SERVER_PORT} -sTCP:LISTEN -t >/dev/null ; then
            echo "❌ Port ${SERVER_PORT} is already in use"
            exit 1
        fi

        # Build the server
        echo "Building server..."
        npx nx build example-server

        if [ $? -ne 0 ]; then
            echo "❌ Build failed"
            exit 1
        fi

        echo "✅ Build completed successfully"

        # Create symlinks for @webpieces libraries
        echo "Creating @webpieces library symlinks..."
        rm -rf node_modules/@webpieces/*
        mkdir -p node_modules/@webpieces

        ln -sf "$(pwd)/dist/packages/core/core-context" node_modules/@webpieces/core-context
        ln -sf "$(pwd)/dist/packages/core/core-meta" node_modules/@webpieces/core-meta
        ln -sf "$(pwd)/dist/packages/core/core-util" node_modules/@webpieces/core-util
        ln -sf "$(pwd)/dist/packages/http/http-api" node_modules/@webpieces/http-api
        ln -sf "$(pwd)/dist/packages/http/http-routing" node_modules/@webpieces/http-routing
        ln -sf "$(pwd)/dist/packages/http/http-filters" node_modules/@webpieces/http-filters
        ln -sf "$(pwd)/dist/packages/http/http-server" node_modules/@webpieces/http-server
        ln -sf "$(pwd)/dist/libraries/apis/example-apis" node_modules/@webpieces/example-apis

        echo "✅ Symlinks created successfully"

        # Create tmp directory for logs
        mkdir -p tmp

        # Run the server with PORT env var
        echo "Starting server..."
        PORT=${SERVER_PORT} NODE_ENV=development node -r reflect-metadata dist/apps/example-server/src/server.js > $LOG_FILE 2>&1 &
        SERVER_PID=$!

        # Save PID
        echo $SERVER_PID > $PID_FILE

        echo "Started server with PID: $SERVER_PID"
        echo "Waiting for server to be ready..."

        # Monitor log for ready message
        for i in {1..60}; do
            if grep -q "listening on" $LOG_FILE 2>/dev/null; then
                echo "✅ Server is ready on port ${SERVER_PORT}"
                echo "✅ Process PID: $SERVER_PID"
                echo "✅ Tail logs with: tail -f $LOG_FILE"
                exit 0
            fi

            if ! kill -0 $SERVER_PID 2>/dev/null; then
                echo "❌ Server process died unexpectedly!"
                echo "Last 20 lines of log:"
                tail -n 20 $LOG_FILE
                exit 1
            fi

            sleep 1
        done

        echo "⚠️  Server started but ready message not seen"
        echo "Last 20 lines of log:"
        tail -n 20 $LOG_FILE
        exit 0
        ;;

    client)
        echo "Starting client on port ${CLIENT_PORT} (N=${N})..."

        LOG_FILE="tmp/client.log"
        PID_FILE="/tmp/webpieces-ts-client-${N}.pid"

        # Check if already running
        if [ -f "$PID_FILE" ]; then
            if kill -0 $(cat "$PID_FILE") 2>/dev/null; then
                echo "❌ Client is already running (PID: $(cat $PID_FILE))"
                exit 1
            else
                echo "⚠️ Removing stale PID file"
                rm -f "$PID_FILE"
            fi
        fi

        if lsof -Pi :${CLIENT_PORT} -sTCP:LISTEN -t >/dev/null ; then
            echo "❌ Port ${CLIENT_PORT} is already in use"
            exit 1
        fi

        # Create tmp directory for logs
        mkdir -p tmp

        # Start Angular dev server
        echo "Starting Angular dev server..."
        npx nx serve example-client --port=${CLIENT_PORT} > $LOG_FILE 2>&1 &
        CLIENT_PID=$!

        # Save PID
        echo $CLIENT_PID > $PID_FILE

        echo "Started client with PID: $CLIENT_PID"
        echo "Waiting for client to be ready..."

        # Monitor log for ready message
        for i in {1..60}; do
            if grep -q "Application bundle generation complete" $LOG_FILE 2>/dev/null || \
               grep -q "Compiled successfully" $LOG_FILE 2>/dev/null; then
                echo "✅ Client is ready on http://localhost:${CLIENT_PORT}"
                echo "✅ Process PID: $CLIENT_PID"
                echo "✅ Tail logs with: tail -f $LOG_FILE"
                exit 0
            fi

            if ! kill -0 $CLIENT_PID 2>/dev/null; then
                echo "❌ Client process died unexpectedly!"
                echo "Last 20 lines of log:"
                tail -n 20 $LOG_FILE
                exit 1
            fi

            sleep 1
        done

        echo "⚠️  Client started but ready message not seen"
        echo "Client may still be starting at http://localhost:${CLIENT_PORT}"
        echo "Tail logs with: tail -f $LOG_FILE"
        exit 0
        ;;

    stop-server)
        PID_FILE="/tmp/webpieces-ts-server-${N}.pid"

        if [ ! -f "$PID_FILE" ]; then
            echo "⚠️  No PID file found. Server may not be running."
            pkill -f "node -r reflect-metadata dist/apps/example-server/src/server.js"
            exit 0
        fi

        SERVER_PID=$(cat "$PID_FILE")

        if ! kill -0 "$SERVER_PID" 2>/dev/null; then
            echo "⚠️  Process $SERVER_PID is not running (stale PID file)"
            rm -f "$PID_FILE"
            exit 0
        fi

        echo "Sending SIGTERM to server process $SERVER_PID..."
        kill "$SERVER_PID"

        for i in {1..10}; do
            if ! kill -0 "$SERVER_PID" 2>/dev/null; then
                echo "✅ Server stopped gracefully"
                rm -f "$PID_FILE"
                exit 0
            fi
            sleep 1
        done

        echo "⚠️  Server didn't stop gracefully, forcing shutdown..."
        kill -9 "$SERVER_PID" 2>/dev/null
        sleep 1
        rm -f "$PID_FILE"
        echo "✅ Server stopped (forced)"
        ;;

    stop-client)
        PID_FILE="/tmp/webpieces-ts-client-${N}.pid"

        if [ ! -f "$PID_FILE" ]; then
            echo "⚠️  No PID file found. Client may not be running."
            pkill -f "nx serve example-client"
            exit 0
        fi

        CLIENT_PID=$(cat "$PID_FILE")

        if ! kill -0 "$CLIENT_PID" 2>/dev/null; then
            echo "⚠️  Process $CLIENT_PID is not running (stale PID file)"
            rm -f "$PID_FILE"
            exit 0
        fi

        echo "Sending SIGTERM to client process $CLIENT_PID..."
        kill "$CLIENT_PID"

        for i in {1..10}; do
            if ! kill -0 "$CLIENT_PID" 2>/dev/null; then
                echo "✅ Client stopped gracefully"
                rm -f "$PID_FILE"
                exit 0
            fi
            sleep 1
        done

        echo "⚠️  Client didn't stop gracefully, forcing shutdown..."
        kill -9 "$CLIENT_PID" 2>/dev/null
        sleep 1
        rm -f "$PID_FILE"
        echo "✅ Client stopped (forced)"
        ;;

    *)
        echo "Unknown service: $SERVICE"
        echo "Usage: $0 <server|client|stop-server|stop-client>"
        exit 1
        ;;
esac
