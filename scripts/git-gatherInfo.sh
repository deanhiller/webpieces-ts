#!/bin/bash
# Gather merge context for git-updateFromMain.sh
# This script can be run standalone for testing or called by other scripts
# Exit on any error
set -e
set -o pipefail

# Calculate MERGE_DIR in persistent workspace webpiecesTmp (30-day retention)
CURRENT_BRANCH=$(git branch --show-current)
FEATURE_NAME=$(./scripts/.workflow/git-readAiBranchName.sh)
REPO_ROOT="$(git rev-parse --show-toplevel)"
MERGE_DIR="${REPO_ROOT}/webpiecesTmp/merge-${FEATURE_NAME}"
mkdir -p "$MERGE_DIR"

# ============================================================
# STEP 1: Validate Current Branch
# ============================================================

# Check if we're on main branch
if [ "$CURRENT_BRANCH" = "main" ]; then
    echo "❌ Error: Already on main branch. No need to update from main." >&2
    exit 1
fi

echo "Current branch: $CURRENT_BRANCH" >&2

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
    echo "" >&2
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
    echo "❌ ERROR: You have uncommitted changes" >&2
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
    echo "" >&2
    echo "Please commit or stash your changes before updating from main." >&2
    echo "" >&2
    echo "Files with changes:" >&2
    git diff --name-only HEAD >&2
    echo "" >&2
    echo -e "\033[1;31mTo commit your changes, run:" >&2
    echo -e "  git add -A && git commit -m \"your message\"\033[0m" >&2
    echo "" >&2
    echo "Or to stash them temporarily:" >&2
    echo "  git stash" >&2
    echo "  ./scripts/git-updateFromMain.sh" >&2
    echo "  git stash pop" >&2
    echo "" >&2
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
    exit 1
fi

# ============================================================
# STEP 2: Gather Merge Context (A/B/C Hash Points)
# ============================================================

echo "" >&2
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
echo "📍 Gathering Merge Context" >&2
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
echo "" >&2

# Fetch latest changes from origin
echo "Fetching latest changes from origin/main..." >&2
git fetch origin main >&2 2>&1

# Call shared fork point detection (writes to MERGE_DIR/updatemain-hashes.json)
if ! ./scripts/.workflow/git-findForkPoint.sh "merge"; then
    # Merge from main detected - ERROR
    echo "" >&2
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
    echo "❌ This branch merged main without git-updateFromMain.sh" >&2
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
    echo "" >&2
    if [ -f "$MERGE_DIR/updatemain-forkpoint-error.json" ]; then
        echo "Merge commit detected: $(jq -r '.mergeCommit' "$MERGE_DIR/updatemain-forkpoint-error.json")" >&2
        echo "Parent from main:      $(jq -r '.parentFromMain' "$MERGE_DIR/updatemain-forkpoint-error.json")" >&2
        echo "" >&2
    fi
    echo "This prevents clean squash-merge. To recover, follow these steps:" >&2
    echo "" >&2
    echo "1. Switch to main branch:" >&2
    echo "   git checkout main" >&2
    echo "" >&2
    echo "2. Pull latest changes:" >&2
    echo "   git pull" >&2
    echo "" >&2
    echo "3. Create new branch with a new name:" >&2
    echo "   git checkout -b ${FEATURE_NAME}-v2" >&2
    echo "" >&2
    echo "4. Squash merge your old branch:" >&2
    echo "   git merge --squash $CURRENT_BRANCH" >&2
    echo "" >&2
    echo "5. Commit the squashed changes:" >&2
    echo "   git add -A && git commit -m \"Squashed from $CURRENT_BRANCH\"" >&2
    echo "" >&2
    echo "6. If you have an existing PR:" >&2
    echo "   - Create a NEW PR for ${FEATURE_NAME}-v2" >&2
    echo "   - Close the old PR for $CURRENT_BRANCH" >&2
    echo "" >&2
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
    echo "" >&2
    exit 1
fi

# Read hash points from file
HASH_A=$(jq -r '.hashForkPoint' "$MERGE_DIR/updatemain-hashes.json")
HASH_B=$(jq -r '.hashFeatureHead' "$MERGE_DIR/updatemain-hashes.json")
HASH_C=$(jq -r '.hashMainHead' "$MERGE_DIR/updatemain-hashes.json")

FORK_POINT="$HASH_A"
FEATURE_HEAD="$HASH_B"
MAIN_HEAD="$HASH_C"

echo "📍 The 3 Hash Points:" >&2
echo "  1. Fork point (A):   $FORK_POINT" >&2
echo "     (where $CURRENT_BRANCH diverged from main)" >&2
echo "" >&2
echo "  2. Feature HEAD (B): $FEATURE_HEAD" >&2
echo "     (tip of $CURRENT_BRANCH)" >&2
echo "" >&2
echo "  3. Main HEAD (C):    $MAIN_HEAD" >&2
echo "     (current origin/main)" >&2
echo "" >&2
echo "Merge directory: $MERGE_DIR" >&2
echo "" >&2

# ============================================================
# STEP 3: Check If Already Up to Date
# ============================================================

if [ "$FORK_POINT" = "$MAIN_HEAD" ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
    echo "✅ Already up to date with main!" >&2
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
    echo "" >&2
    echo "Your branch has not diverged from main." >&2
    echo "There are no new changes from main to merge." >&2
    echo "" >&2
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
    exit 0
fi

echo "Main has advanced. Merge will be needed." >&2
echo "" >&2
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
echo "" >&2
