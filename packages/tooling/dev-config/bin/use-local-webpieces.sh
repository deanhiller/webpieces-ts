#!/bin/bash
set -e

# Switch to local webpieces packages for development
# This script links to local dist/ packages instead of published npm packages

# Detect project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$SCRIPT_DIR" == *"node_modules/@webpieces/dev-config"* ]]; then
  # Running in consumer project
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
else
  # Running in webpieces-ts workspace
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
fi

cd "$PROJECT_ROOT" || exit 1

echo "🔗 Switching to local @webpieces packages..."

# Check if WEBPIECES_ROOT environment variable is set
if [ -z "$WEBPIECES_ROOT" ]; then
  echo "❌ WEBPIECES_ROOT environment variable not set"
  echo "   Please set it to your webpieces-ts directory:"
  echo "   export WEBPIECES_ROOT=/path/to/webpieces-ts"
  exit 1
fi

if [ ! -d "$WEBPIECES_ROOT/dist/packages" ]; then
  echo "❌ webpieces-ts dist/ directory not found at: $WEBPIECES_ROOT/dist/packages"
  echo "   Have you built webpieces-ts? Run: npm run build"
  exit 1
fi

# Remove existing @webpieces packages
echo "   Removing published @webpieces packages..."
rm -rf node_modules/@webpieces/*
mkdir -p node_modules/@webpieces

# Create symlinks to local dist packages
echo "   Creating symlinks to local packages..."

# Core packages
if [ -d "$WEBPIECES_ROOT/dist/packages/core/core-context" ]; then
  ln -sf "$WEBPIECES_ROOT/dist/packages/core/core-context" node_modules/@webpieces/core-context
  echo "   ✅ core-context"
fi

if [ -d "$WEBPIECES_ROOT/dist/packages/core/core-meta" ]; then
  ln -sf "$WEBPIECES_ROOT/dist/packages/core/core-meta" node_modules/@webpieces/core-meta
  echo "   ✅ core-meta"
fi

# HTTP packages
if [ -d "$WEBPIECES_ROOT/dist/packages/http/http-routing" ]; then
  ln -sf "$WEBPIECES_ROOT/dist/packages/http/http-routing" node_modules/@webpieces/http-routing
  echo "   ✅ http-routing"
fi

if [ -d "$WEBPIECES_ROOT/dist/packages/http/http-filters" ]; then
  ln -sf "$WEBPIECES_ROOT/dist/packages/http/http-filters" node_modules/@webpieces/http-filters
  echo "   ✅ http-filters"
fi

if [ -d "$WEBPIECES_ROOT/dist/packages/http/http-server" ]; then
  ln -sf "$WEBPIECES_ROOT/dist/packages/http/http-server" node_modules/@webpieces/http-server
  echo "   ✅ http-server"
fi

if [ -d "$WEBPIECES_ROOT/dist/packages/http/http-client" ]; then
  ln -sf "$WEBPIECES_ROOT/dist/packages/http/http-client" node_modules/@webpieces/http-client
  echo "   ✅ http-client"
fi

if [ -d "$WEBPIECES_ROOT/dist/packages/http/http-api" ]; then
  ln -sf "$WEBPIECES_ROOT/dist/packages/http/http-api" node_modules/@webpieces/http-api
  echo "   ✅ http-api"
fi

# Tooling packages
if [ -d "$WEBPIECES_ROOT/dist/packages/tooling/dev-config" ]; then
  ln -sf "$WEBPIECES_ROOT/dist/packages/tooling/dev-config" node_modules/@webpieces/dev-config
  echo "   ✅ dev-config"
fi

echo ""
echo "✅ Successfully switched to local @webpieces packages from: $WEBPIECES_ROOT"
echo "   To switch back to published packages, run: wp-use-published"
