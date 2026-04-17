#!/bin/bash
set -e

# Setup Claude pattern files by creating symlinks
# This script runs as postinstall to make Claude documentation available

# Detect project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$SCRIPT_DIR" == *"node_modules/@webpieces/dev-config"* ]]; then
  # Running in consumer project (from node_modules)
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
  PATTERNS_DIR="$SCRIPT_DIR/../patterns"
else
  # Running in webpieces-ts workspace
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
  PATTERNS_DIR="$PROJECT_ROOT/packages/tooling/dev-config/patterns"
fi

cd "$PROJECT_ROOT" || exit 1

echo "🔗 Setting up Claude pattern files..."

# Create .claude directory if it doesn't exist
mkdir -p .claude

# Check if patterns exist
if [ ! -f "$PATTERNS_DIR/CLAUDE.md" ]; then
  echo "⚠️  Warning: CLAUDE.md not found in patterns directory"
  echo "   Expected: $PATTERNS_DIR/CLAUDE.md"
else
  # Create relative symlink to CLAUDE.md
  echo "   Creating symlink for CLAUDE.md..."
  ln -sf "$PATTERNS_DIR/CLAUDE.md" .claude/CLAUDE.md
  echo "   ✅ .claude/CLAUDE.md"
fi

if [ ! -f "$PATTERNS_DIR/claude.patterns.md" ]; then
  echo "⚠️  Warning: claude.patterns.md not found in patterns directory"
  echo "   Expected: $PATTERNS_DIR/claude.patterns.md"
else
  # Create relative symlink to claude.patterns.md
  echo "   Creating symlink for claude.patterns.md..."
  ln -sf "$PATTERNS_DIR/claude.patterns.md" .claude/claude.patterns.md
  echo "   ✅ .claude/claude.patterns.md"
fi

echo ""
echo "✅ Claude pattern files are available in .claude/"
echo "   These files are symlinked from @webpieces/dev-config"
echo "   They will auto-update when you upgrade the package"
