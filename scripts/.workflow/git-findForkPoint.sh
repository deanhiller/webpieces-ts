#!/bin/bash
# Walk backwards from HEAD to find original fork point from main
# Detect if branch has merged main (blocking condition)
#
# Usage: git-findForkPoint.sh <workflow>
#   workflow: "review" or "merge"
#
# Output:
#   review: Writes to CONTEXT_DIR/review-hashes.json
#   merge:  Writes to MERGE_DIR/updatemain-hashes.json
#   ERROR:  Writes to {DIR}/{prefix}forkpoint-error.json and exits 1

set -e
set -o pipefail

# Validate workflow argument
if [ -z "$1" ]; then
    echo "ERROR: Workflow argument required" >&2
    echo "Usage: $0 <workflow>" >&2
    echo "  workflow: 'review' or 'merge'" >&2
    echo "" >&2
    echo "Examples:" >&2
    echo "  $0 review  # For code review workflow" >&2
    echo "  $0 merge   # For merge/update workflow" >&2
    exit 1
fi

WORKFLOW="$1"

# Validate workflow value
if [ "$WORKFLOW" != "review" ] && [ "$WORKFLOW" != "merge" ]; then
    echo "ERROR: Invalid workflow '$WORKFLOW'" >&2
    echo "Usage: $0 <workflow>" >&2
    echo "  workflow: 'review' or 'merge'" >&2
    exit 1
fi

# Calculate directories and prefix based on workflow
CURRENT_BRANCH=$(git branch --show-current)
FEATURE_NAME=$(./scripts/.workflow/git-readAiBranchName.sh)

if [ "$WORKFLOW" = "review" ]; then
    # Review workflow (persistent 30-day retention)
    REPO_ROOT="$(git rev-parse --show-toplevel)"
    OUTPUT_DIR="${REPO_ROOT}/webpiecesTmp/review-${FEATURE_NAME}"
    mkdir -p "$OUTPUT_DIR"
    PREFIX="review-"
else
    # Merge workflow (persistent 30-day retention)
    REPO_ROOT="$(git rev-parse --show-toplevel)"
    OUTPUT_DIR="${REPO_ROOT}/webpiecesTmp/merge-${FEATURE_NAME}"
    mkdir -p "$OUTPUT_DIR"
    PREFIX="updatemain-"
fi

# Fetch latest main
git fetch origin main >/dev/null 2>&1

FEATURE_HEAD=$(git rev-parse HEAD)
ORIGIN_MAIN=$(git rev-parse origin/main)

echo "Finding fork point using git merge-base..." >&2

# Calculate fork point instantly using git merge-base
FORK_POINT=$(git merge-base origin/main HEAD)

if [ -z "$FORK_POINT" ]; then
    echo "ERROR: Could not find common ancestor with origin/main" >&2
    exit 1
fi

FORK_SHORT=$(echo "$FORK_POINT" | cut -c1-7)
echo "✅ Fork point found: $FORK_SHORT" >&2

# Check for merge-from-main violations
echo "Checking for improper merges from main..." >&2

# Get all merge commits between fork point and HEAD (commits with 2+ parents)
MERGE_COMMITS=$(git log $FORK_POINT..HEAD --merges --format="%H" 2>/dev/null || true)

if [ -n "$MERGE_COMMITS" ]; then
    MERGE_COUNT=$(echo "$MERGE_COMMITS" | wc -l | tr -d ' ')
    echo "Found $MERGE_COUNT merge commit(s) to check..." >&2

    # Check each merge commit
    for commit in $MERGE_COMMITS; do
        # Get all parents of this merge commit
        PARENTS=$(git rev-list --parents -n 1 $commit | cut -d' ' -f2-)

        # Check if any parent is from origin/main
        for parent in $PARENTS; do
            # Check if parent is on origin/main (both directions for exact match)
            if git merge-base --is-ancestor $parent origin/main 2>/dev/null && \
               git merge-base --is-ancestor origin/main $parent 2>/dev/null; then
                # This parent IS on origin/main - merge from main detected!
                COMMIT_SHORT=$(echo "$commit" | cut -c1-7)
                PARENT_SHORT=$(echo "$parent" | cut -c1-7)
                echo "ERROR: Merge from main detected at commit $COMMIT_SHORT" >&2
                cat > "$OUTPUT_DIR/${PREFIX}forkpoint-error.json" <<EOF
{
  "error": "Merge from main detected",
  "mergeCommit": "$commit",
  "parentFromMain": "$parent",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
                echo "ERROR: Written to $OUTPUT_DIR/${PREFIX}forkpoint-error.json" >&2
                exit 1
            fi
        done
    done
    echo "✅ No improper merges from main detected" >&2
else
    echo "✅ No merge commits found (clean history)" >&2
fi

# Success - write hash points
cat > "$OUTPUT_DIR/${PREFIX}hashes.json" <<EOF
{
  "hashForkPoint": "$FORK_POINT",
  "hashFeatureHead": "$FEATURE_HEAD",
  "hashMainHead": "$ORIGIN_MAIN",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo "✅ Hash points written to: $OUTPUT_DIR/${PREFIX}hashes.json" >&2
exit 0
