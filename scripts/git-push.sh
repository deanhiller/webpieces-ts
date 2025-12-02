#!/bin/bash
# ============================================================
# git-push.sh - Simple Git Commit with Prettier Formatting
# ============================================================
#
# PURPOSE:
#   Commits changes and runs prettier on files changed since fork from main.
#   Keeps code consistently formatted before pushing.
#
# USAGE:
#   ./scripts/git-push.sh "Your commit message"
#
# FLOW:
#   1. Validate commit message provided
#   2. Validate not on main branch
#   3. git add -A (stage all changes)
#   4. git commit with message
#   5. Find fork point from main
#   6. Run prettier on files changed since fork
#   7. If prettier changed anything, amend commit
#
# ============================================================

set -e
set -o pipefail

# ============================================================
# Validate Arguments
# ============================================================

if [ -z "$1" ]; then
    echo ""
    echo "Usage: ./scripts/git-push.sh \"Your commit message\""
    echo ""
    exit 1
fi

COMMIT_MESSAGE="$1"

# ============================================================
# Validate Branch
# ============================================================

CURRENT_BRANCH=$(git branch --show-current)

if [ "$CURRENT_BRANCH" = "main" ]; then
    echo ""
    echo "Error: Cannot run this script on main branch."
    echo "Please create a feature branch first."
    echo ""
    exit 1
fi

echo ""
echo "Branch: $CURRENT_BRANCH"
echo "Message: $COMMIT_MESSAGE"
echo ""

# ============================================================
# Stage and Commit
# ============================================================

echo "Staging all changes..."
git add -A

# Check if there are changes to commit
if git diff --cached --quiet; then
    echo "No changes to commit."
    exit 0
fi

echo "Committing..."
git commit -m "$COMMIT_MESSAGE

Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"

# ============================================================
# Find Fork Point and Run Prettier on Changed Files
# ============================================================

echo ""
echo "Finding fork point from main..."

# Get the fork point (where this branch diverged from main)
FORK_POINT=$(git merge-base main HEAD)
echo "Fork point: $FORK_POINT"

# Get list of files changed since fork (only .ts, .tsx, .js, .jsx, .json files)
echo ""
echo "Finding files changed since fork..."
CHANGED_FILES=$(git diff --name-only "$FORK_POINT" HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.json' 2>/dev/null || true)

if [ -z "$CHANGED_FILES" ]; then
    echo "No formattable files changed since fork from main."
    echo ""
    echo "Done! Ready to push."
    exit 0
fi

echo "Changed files:"
echo "$CHANGED_FILES" | sed 's/^/  /'
echo ""

# Filter to only existing files (some might have been deleted)
EXISTING_FILES=""
for file in $CHANGED_FILES; do
    if [ -f "$file" ]; then
        EXISTING_FILES="$EXISTING_FILES $file"
    fi
done

if [ -z "$EXISTING_FILES" ]; then
    echo "No existing formattable files to format."
    echo ""
    echo "Done! Ready to push."
    exit 0
fi

# ============================================================
# Run Prettier on Changed Files
# ============================================================

echo "Running prettier on changed files..."
npx prettier --write $EXISTING_FILES

# Check if prettier made any changes
if git diff --quiet; then
    echo "Prettier made no changes."
    echo ""
    echo "Done! Ready to push."
    exit 0
fi

# ============================================================
# Amend Commit with Prettier Changes
# ============================================================

echo ""
echo "Prettier made formatting changes. Amending commit..."
git add -A
git commit --amend --no-edit

echo ""
echo "Done! Commit amended with formatting. Ready to push."
echo ""
