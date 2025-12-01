#!/bin/bash
set -e

# Switch back to published webpieces packages from npm
# This script removes local symlinks and reinstalls from npm

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

echo "📦 Switching to published @webpieces packages..."

# Remove all @webpieces symlinks
echo "   Removing local symlinks..."
rm -rf node_modules/@webpieces

# Reinstall from npm
echo "   Reinstalling from npm..."
npm install

echo ""
echo "✅ Successfully switched to published @webpieces packages from npm"
echo "   To switch back to local development, run: wp-use-local"
echo "   (Make sure to set WEBPIECES_ROOT environment variable first)"
