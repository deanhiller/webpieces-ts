#!/bin/bash
# Script to stage merge changes for human review
# This is used during the /merge workflow after AI resolves conflicts
# Human must review and commit manually

set -e
set -o pipefail

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📝 Staging Merge Changes for Review"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Get current branch
CURRENT_BRANCH=$(git branch --show-current)

# Compute the hash points for reference
# New fork point is current main HEAD (this becomes the new base)
NEW_FORK_POINT=$(git rev-parse origin/main 2>/dev/null || git rev-parse main)

# Old fork point needs to be computed from the branch being merged
# Check if we're in a merge state
if git rev-parse --verify MERGE_HEAD >/dev/null 2>&1; then
    # We're in the middle of a merge - MERGE_HEAD points to what we're merging in
    MERGE_HEAD=$(git rev-parse MERGE_HEAD)
    OLD_FORK_POINT=$(git merge-base "$MERGE_HEAD" origin/main)
else
    # Not in merge state - compute from current branch
    OLD_FORK_POINT=$(git merge-base HEAD origin/main)
fi

# Show what we're doing
echo "Branch: $CURRENT_BRANCH"
echo "Old fork point: ${OLD_FORK_POINT:0:12}"
echo "New fork point: ${NEW_FORK_POINT:0:12}"
echo ""

# Stage all changes
echo "Staging all resolved changes..."
git add -A

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ All changes staged for review"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📋 Review staged changes with:"
echo "   git diff --cached"
echo ""
echo "📋 View list of changed files:"
echo "   git status"
echo ""
echo "⚠️  REVIEW CAREFULLY before committing!"
echo ""
echo "When ready to commit, the git-updateFromMain.sh script will continue."
echo ""
