#!/bin/bash
# Script to validate that current branch is up to date with origin/main
# This ensures test plans and commits reflect all latest changes from main
# Exit on any error
set -e
set -o pipefail

# Get the current branch name
CURRENT_BRANCH=$(git branch --show-current)

# Check if we're on main branch
if [ "$CURRENT_BRANCH" = "main" ]; then
    echo "✅ On main branch - no validation needed"
    exit 0
fi

echo "Validating branch is up to date with origin/main..."
echo "Current branch: $CURRENT_BRANCH"
echo ""

# Fetch latest from origin/main (quietly)
echo "Fetching latest from origin/main..."
git fetch origin main --quiet

# Check if origin/main is an ancestor of current branch
# If true, current branch has all commits from origin/main (up to date)
# If false, origin/main has commits that current branch doesn't have (outdated)
if git merge-base --is-ancestor origin/main HEAD; then
    echo "✅ Branch is up to date with origin/main"
    exit 0
else
    # Check if there are any commits in origin/main not in current branch
    COMMITS_BEHIND=$(git rev-list --count HEAD..origin/main)

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "❌ ERROR: Branch is NOT up to date with origin/main"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Your branch is $COMMITS_BEHIND commit(s) behind origin/main"
    echo ""
    echo "Recent commits in origin/main not in your branch:"
    git log --oneline HEAD..origin/main | head -5
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "⚠️  CRITICAL: You must update your branch first!"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "1. Update your branch with latest main:"
    echo "   ./scripts/git-updateFromMain.sh"
    echo ""
    echo "2. ⚠️  IMPORTANT: REVIEW THE CODE AFTER MERGE!"
    echo "   - Check for merge conflicts"
    echo "   - Review how your changes interact with new main code"
    echo "   - Test that everything still works"
    echo "   - This is where things often go wrong!"
    echo ""
    echo "3. After reviewing, run your command again"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Why this matters:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "- Your test plan should cover how your changes work with"
    echo "  the LATEST code from main, not outdated code"
    echo "- Merging main might introduce conflicts or integration"
    echo "  issues that need testing"
    echo "- Your changes might interact unexpectedly with new code"
    echo "  from main"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    exit 1
fi
