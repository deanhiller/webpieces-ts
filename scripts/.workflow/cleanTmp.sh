#!/bin/bash
# ============================================================
# cleanTmp.sh - Clean old temporary directories
# ============================================================
#
# PURPOSE:
#   Removes temporary directories older than 30 days from the
#   persistent workspace webpiecesTmp directory.
#
# USAGE:
#   Called automatically at the end of git-updateFromMain.sh
#   Can also be run manually: ./scripts/.workflow/cleanTmp.sh
#
# RETENTION POLICY:
#   - Directories older than 30 days are deleted
#   - Uses modification time (mtime) to determine age
#   - Only removes directories, not individual files
#
# LOCATION:
#   ${REPO_ROOT}/webpiecesTmp/
#
# ============================================================

# Calculate persistent webpiecesTmp directory (matches pattern in other scripts)
REPO_ROOT="$(git rev-parse --show-toplevel)"
TMP_BASE="${REPO_ROOT}/webpiecesTmp"

# Retention policy: delete directories older than this many days
CUTOFF_DAYS=30

# Exit early if webpiecesTmp directory doesn't exist (nothing to clean)
if [ ! -d "$TMP_BASE" ]; then
    exit 0
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🧹 Cleaning Old Temporary Directories"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Location: $TMP_BASE"
echo "Retention: ${CUTOFF_DAYS} days"
echo ""

# Find and delete directories older than CUTOFF_DAYS
# -maxdepth 1: only look at direct subdirectories, not nested
# -type d: only directories
# -mtime +N: modified more than N days ago
# ! -path "$TMP_BASE": exclude the base directory itself
DELETED_COUNT=0

# First, list what will be deleted (for logging)
while IFS= read -r dir; do
    if [ -n "$dir" ] && [ "$dir" != "$TMP_BASE" ]; then
        DIR_NAME=$(basename "$dir")
        DIR_AGE=$(find "$dir" -maxdepth 0 -mtime +${CUTOFF_DAYS} -printf '%Td days old\n' 2>/dev/null || echo "old")
        echo "  🗑️  Deleting: $DIR_NAME ($DIR_AGE)"
        rm -rf "$dir"
        DELETED_COUNT=$((DELETED_COUNT + 1))
    fi
done < <(find "$TMP_BASE" -maxdepth 1 -type d -mtime +${CUTOFF_DAYS} ! -path "$TMP_BASE")

if [ $DELETED_COUNT -eq 0 ]; then
    echo "  ✅ No directories older than ${CUTOFF_DAYS} days found"
else
    echo ""
    echo "  ✅ Deleted $DELETED_COUNT old director$([ $DELETED_COUNT -eq 1 ] && echo 'y' || echo 'ies')"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
