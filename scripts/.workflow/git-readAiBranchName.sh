#!/bin/bash

# This script converts the current branch name to a safe directory name
# by replacing slashes with dashes (e.g., "deanhiller/feature" -> "deanhiller-feature")
#
# This ensures unique directory names even when multiple developers work on branches
# with the same feature name (e.g., "alice/fix-bug" vs "bob/fix-bug")
#
# Usage:
#   FEATURE_NAME=$(./scripts/.workflow/git-readAiBranchName.sh)
#   OR source it and use $FEATURE_NAME variable

set -e

CURRENT_BRANCH=$(git branch --show-current)
FEATURE_NAME=$(echo "$CURRENT_BRANCH" | tr '/' '-')

# Strip "Squash" suffix if present (for merge directory lookup)
FEATURE_NAME=$(echo "$FEATURE_NAME" | sed 's/Squash$//')

# If sourced, export the variable; if executed, echo it
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    # Script is being executed
    echo "$FEATURE_NAME"
else
    # Script is being sourced
    export FEATURE_NAME
fi
