#!/bin/bash

# Start script for webpieces-ts server
# Based on trytami's local-start.sh pattern

PORT=${1:-8080}
LOG_FILE="tmp/server.log"
PID_FILE="/tmp/webpieces-ts-server.pid"

echo "Starting webpieces-ts server on port $PORT..."
echo "Logs: $LOG_FILE"

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

if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null ; then
    echo "❌ Port $PORT is already in use"
    exit 1
fi

# Ensure we're in project root
cd "$(dirname "$0")/.." || exit 1

# Build the server
echo "Building server..."
npx nx build example-app

if [ $? -ne 0 ]; then
    echo "❌ Build failed"
    exit 1
fi

echo "✅ Build completed successfully"

# Create symlinks for @webpieces libraries (required for production build)
echo "Creating @webpieces library symlinks..."
rm -rf node_modules/@webpieces/*
mkdir -p node_modules/@webpieces

# Create symlinks to dist packages
ln -sf "$(pwd)/dist/packages/core/core-context" node_modules/@webpieces/core-context
ln -sf "$(pwd)/dist/packages/core/core-meta" node_modules/@webpieces/core-meta
ln -sf "$(pwd)/dist/packages/http/http-routing" node_modules/@webpieces/http-routing
ln -sf "$(pwd)/dist/packages/http/http-filters" node_modules/@webpieces/http-filters
ln -sf "$(pwd)/dist/packages/http/http-server" node_modules/@webpieces/http-server

echo "✅ Symlinks created successfully"

# Create tmp directory for logs
mkdir -p tmp

# Run the production build (with reflect-metadata loaded first)
echo "Starting server..."
NODE_ENV=development PORT=$PORT node -r reflect-metadata dist/apps/example-app/src/server.js > $LOG_FILE 2>&1 &
SERVER_PID=$!

# Save PID
echo $SERVER_PID > $PID_FILE

echo "Started server with PID: $SERVER_PID"
echo "Waiting for server to be ready..."

# Monitor log for ready message
for i in {1..60}; do
    if grep -q "listening on" $LOG_FILE 2>/dev/null; then
        echo "✅ Server is ready on port $PORT"
        echo "✅ Process PID: $SERVER_PID"
        echo "✅ Tail logs with: tail -f $LOG_FILE"
        exit 0
    fi

    # Check if process is still alive
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
echo ""
echo "Server may still be starting. Check logs with: tail -f $LOG_FILE"
exit 0
