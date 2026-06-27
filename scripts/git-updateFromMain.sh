#!/bin/bash
# ============================================================
# git-updateFromMain.sh - Squash-Merge Workflow with AI Integration
# ============================================================
#
# PURPOSE:
#   Updates a feature branch with latest changes from main using a squash-merge strategy.
#   This creates a clean, linear history by squashing all feature commits into one, then
#   rebasing onto the latest main. Optionally uses AI to resolve merge conflicts.
#
# ============================================================
# COMPLETE FLOW DOCUMENTATION
# ============================================================
#
# PREREQUISITES (validated by git-gatherInfo.sh):
#   - Working tree must be clean (no uncommitted changes)
#   - Must be on a feature branch (not main)
#   - Main must have new changes since branch creation (otherwise early exit: "already up-to-date")
#   - Git must be in clean state (no merge/rebase in progress)
#   - Note: Feature branch can have zero commits - script works for fast-forward updates too
#
# FLOW STAGES:
#
# ┌─────────────────────────────────────────────────────────────┐
# │ STAGE 1: GATHER MERGE CONTEXT                              │
# └─────────────────────────────────────────────────────────────┘
#   1. Calculate MERGE_DIR in ${REPO_ROOT}/webpiecesTmp (30-day retention)
#   2. Call git-gatherInfo.sh to validate:
#      - Validates working tree is clean
#      - Validates on feature branch (not main)
#      - Calls git-findForkPoint.sh which calculates fork point (A), feature head (B), main head (C)
#      - Writes to: ${REPO_ROOT}/webpiecesTmp/merge-${FEATURE_NAME}/updatemain-hashes.json (gold standard)
#      - Early exits if already up-to-date (FORK_POINT == MAIN_HEAD)
#   3. Read hash points from gold standard file (updatemain-hashes.json)
#   4. Detect existing PR early (for later update)
#      - Uses gh pr list to find PR by head branch
#
# ┌─────────────────────────────────────────────────────────────┐
# │ STAGE 2: CREATE INCREMENTAL BACKUP                         │
# └─────────────────────────────────────────────────────────────┘
#   1. Find next available backup number (Backup1, Backup2, etc.)
#   2. Create backup branch: ${CURRENT_BRANCH}BackupN
#   3. Return to current branch
#   Purpose: Safety net - can recover if merge goes wrong
#
# ┌─────────────────────────────────────────────────────────────┐
# │ STAGE 3: CREATE TEMPORARY SQUASH BRANCH                    │
# └─────────────────────────────────────────────────────────────┘
#   1. Check for leftover Squash branch from previous failure
#      - If exists: prompt user to delete or abort
#   2. Update local main to latest (git pull origin main)
#   3. Create ${CURRENT_BRANCH}Squash from main HEAD
#   Purpose: Merge target - represents "feature + latest main"
#
# ┌─────────────────────────────────────────────────────────────┐
# │ STAGE 4: SQUASH MERGE WITH CONFLICT HANDLING               │
# └─────────────────────────────────────────────────────────────┘
#   1. Attempt: git merge --squash $CURRENT_BRANCH
#
#   SUCCESS PATH (no conflicts):
#     - Check if anything staged
#     - If staged: commit with "Squash merge of $CURRENT_BRANCH"
#     - If nothing staged: already up-to-date (skip commit)
#
#   CONFLICT PATH (conflicts detected):
#     a. Save conflicted files list to MERGE_DIR
#     b. For each conflicted file, save to MERGE_DIR:
#        - A-forkpoint.txt:  File at fork point (A)
#        - B-feature.txt:    File at feature head (B)
#        - C-main.txt:       File at main head (C)
#        - B-A.diff:         Changes from fork to feature
#        - C-A.diff:         Changes from fork to main
#     c. Prompt user: "Would you like AI to help resolve conflicts?"
#
#     AI PATH (user says yes):
#       - Launch: claude (interactive merge command)
#       - Claude reads .claude/commands/wp-merge.md for instructions
#       - Note: Environment variables don't carry to interactive Claude sessions
#       - Display warning to review AI's work and delete comment blocks
#       - User must complete merge and commit
#
#     MANUAL PATH (user says no):
#       - Loop until user confirms merge complete
#       - Verify working tree is clean before continuing
#
# ┌─────────────────────────────────────────────────────────────┐
# │ STAGE 5: DELETE STALE FEATURE BRANCH LOCALLY               │
# └─────────────────────────────────────────────────────────────┘
#   1. Delete local feature branch: git branch -D $CURRENT_BRANCH
#   Purpose: Clean slate - Squash branch will become new feature branch
#
# ┌─────────────────────────────────────────────────────────────┐
# │ STAGE 6: UPDATE PR OR RENAME BRANCH                        │
# └─────────────────────────────────────────────────────────────┘
#   PATH A: Existing PR found (PR_NUMBER is set)
#     1. Force push Squash branch to origin feature branch:
#        git push -u --force-with-lease origin $SQUASH_BRANCH:$CURRENT_BRANCH
#     2. Rename local Squash branch to feature branch:
#        git branch -m $CURRENT_BRANCH
#     3. Display success summary with PR number
#
#   PATH B: No PR found (PR_NUMBER is empty)
#     1. Rename local Squash branch to feature branch:
#        git branch -m $CURRENT_BRANCH
#     2. Display summary (user can create PR later with gh pr create)
#
#   Both paths display:
#     - Branch name, PR number (if exists), backup name
#     - Next steps
#
# ============================================================
# POTENTIAL EDGE CASES & RECOVERY
# ============================================================
#
# EDGE CASE 1: Uncommitted changes before running
#   - HANDLED: git-gatherInfo.sh validates working tree is clean
#   - If dirty: script exits with clear error message
#
# EDGE CASE 2: Squash branch exists from previous failure
#   - HANDLED: Prompts user to delete and start fresh or abort
#   - If user aborts: exit cleanly (backup already created)
#
# EDGE CASE 3: AI merge fails or user cancels during AI merge
#   - PARTIAL: AI exits, but working tree may be dirty
#   - RECOVERY: User must manually complete merge or restore backup
#
# EDGE CASE 4: Network failure during git pull origin main
#   - UNHANDLED: Script will exit with git error (set -e)
#   - RECOVERY: User can re-run script (backup exists)
#
# EDGE CASE 5: Force push fails (network, permissions, etc.)
#   - UNHANDLED: Script exits with git error
#   - RECOVERY: User still on Squash branch, can retry push manually
#
# EDGE CASE 6: PR manually deleted on GitHub
#   - HANDLED: gh pr list returns empty, script treats as "no PR"
#   - Result: Creates new branch state, user can create new PR
#
# EDGE CASE 7: Backup branches accumulate (Backup1, Backup2, ...)
#   - HANDLED: Script finds next available number automatically
#
# EDGE CASE 8: User on main branch when running
#   - HANDLED: git-gatherInfo.sh validates on feature branch
#
# EDGE CASE 9: Main has diverged significantly (100+ commits)
#   - PARTIAL: Squash merge still works, but may have many conflicts
#
# EDGE CASE 10: Multiple users updating same PR simultaneously
#   - UNHANDLED: Last push wins, potential data loss
#   - MITIGATION: --force-with-lease provides some protection
#
# ============================================================
# FILES CREATED/MODIFIED
# ============================================================
#
# ~/.webpieces/settings.json               - User preferences
#   ai_merge_conflicts: true/false         - Whether to use AI for merge conflict resolution
#
# ${REPO_ROOT}/webpiecesTmp/merge-${FEATURE_NAME}/
#   updatemain-hashes.json                 - Gold standard (A, B, C hash points + timestamp)
#   updatemain-conflicted-files.txt        - List of conflicted files
#   updatemain-${SAFE_PATH}/               - Per-file conflict context (if conflicts)
#     A-forkpoint.txt                      - File at fork point
#     B-feature.txt                        - File at feature head
#     C-main.txt                           - File at main head
#     B-A.diff                             - Feature changes (B - A)
#     C-A.diff                             - Main changes (C - A)
#
# Git branches created:
#   ${CURRENT_BRANCH}BackupN               - Safety backup
#   ${CURRENT_BRANCH}Squash                - Temporary merge branch (deleted at end)
#
# ============================================================

# Exit on any error
set -e
set -o pipefail

# Calculate MERGE_DIR in persistent workspace webpiecesTmp (30-day retention)
CURRENT_BRANCH=$(git branch --show-current)
FEATURE_NAME=$(./scripts/.workflow/git-readAiBranchName.sh)
REPO_ROOT="$(git rev-parse --show-toplevel)"
MERGE_DIR="${REPO_ROOT}/webpiecesTmp/merge-${FEATURE_NAME}"
mkdir -p "$MERGE_DIR"

# ============================================================================
# SETTINGS FILE MANAGEMENT
# ============================================================================

SETTINGS_DIR="$HOME/.webpieces"
SETTINGS_FILE="$SETTINGS_DIR/settings.json"

# Read AI merge preference from settings file
get_ai_merge_preference() {
    if [ -f "$SETTINGS_FILE" ]; then
        if command -v jq &> /dev/null; then
            local ai_setting=$(jq -r 'if has("ai_merge_conflicts") then .ai_merge_conflicts else "unset" end' "$SETTINGS_FILE" 2>/dev/null)
            if [ "$ai_setting" = "true" ]; then
                echo "yes"
                return
            elif [ "$ai_setting" = "false" ]; then
                echo "no"
                return
            fi
        fi
    fi
    echo ""
}

# Save AI merge preference to settings file (preserving other settings)
save_ai_merge_preference() {
    local use_ai="$1"
    mkdir -p "$SETTINGS_DIR"

    if [ -f "$SETTINGS_FILE" ]; then
        # File exists - update or add the ai_merge_conflicts key
        local tmp_file=$(mktemp)
        if [ "$use_ai" = "true" ]; then
            jq '.ai_merge_conflicts = true' "$SETTINGS_FILE" > "$tmp_file" && mv "$tmp_file" "$SETTINGS_FILE"
        else
            jq '.ai_merge_conflicts = false' "$SETTINGS_FILE" > "$tmp_file" && mv "$tmp_file" "$SETTINGS_FILE"
        fi
    else
        # File doesn't exist - create it
        if [ "$use_ai" = "true" ]; then
            echo '{"ai_merge_conflicts": true}' > "$SETTINGS_FILE"
        else
            echo '{"ai_merge_conflicts": false}' > "$SETTINGS_FILE"
        fi
    fi
}

# ============================================================
# STEP 1: Gather Merge Context
# ============================================================

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔄 Squash-Merge Workflow"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Call git-gatherInfo.sh to validate (exits early if up-to-date)
echo "Gathering merge context..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/git-gatherInfo.sh"

# Read hash points from gold standard file (written by git-findForkPoint.sh)
FORK_POINT=$(jq -r '.hashForkPoint' "$MERGE_DIR/updatemain-hashes.json")
FEATURE_HEAD=$(jq -r '.hashFeatureHead' "$MERGE_DIR/updatemain-hashes.json")
MAIN_HEAD=$(jq -r '.hashMainHead' "$MERGE_DIR/updatemain-hashes.json")

# ============================================================
# Detect Existing PR Early
# ============================================================

echo ""
echo "Checking for existing PR..."
PR_NUMBER=$(gh pr list --head "$CURRENT_BRANCH" --json number \
    --jq '.[0].number' 2>/dev/null || echo "")

if [ -n "$PR_NUMBER" ]; then
    echo "✅ Found existing PR #$PR_NUMBER (will be updated after merge)"
else
    echo "ℹ️  No existing PR found (you can create one later with gh pr create)"
fi
echo ""

# ============================================================
# STEP 2: Create Incremental Backup
# ============================================================

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "💾 Creating Incremental Backup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Find next available BackupN
N=1
while git show-ref --verify --quiet "refs/heads/${CURRENT_BRANCH}Backup${N}"; do
    N=$((N + 1))
done

BACKUP_BRANCH="${CURRENT_BRANCH}Backup${N}"
echo "Creating backup: $BACKUP_BRANCH"
git checkout -b "$BACKUP_BRANCH"
git checkout "$CURRENT_BRANCH"
echo "✅ Backup created: $BACKUP_BRANCH"
echo ""

# ============================================================
# STEP 3: Create Temporary Squash Branch
# ============================================================

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔄 Creating Temporary Squash Branch"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check for leftover Squash branch from previous failure
if git show-ref --verify --quiet "refs/heads/${CURRENT_BRANCH}Squash"; then
    echo "⚠️  Found existing ${CURRENT_BRANCH}Squash from previous run"
    read -p "Delete and start fresh? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        git branch -D "${CURRENT_BRANCH}Squash"
    else
        echo "❌ Aborting. Please clean up manually."
        exit 1
    fi
fi

# Update local main to latest
echo "Updating local main branch..."
git checkout main
git pull origin main

# Create new Squash branch from main HEAD
SQUASH_BRANCH="${CURRENT_BRANCH}Squash"
echo "Creating new branch: $SQUASH_BRANCH from main..."
git checkout -b "$SQUASH_BRANCH"
echo ""

# ============================================================
# STEP 4: Squash Merge with Conflict Handling
# ============================================================

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔀 Squash Merging $CURRENT_BRANCH"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if git merge --squash "$CURRENT_BRANCH"; then
    # No conflicts - check if there's anything to commit
    echo ""
    echo "✅ Squash merge successful (no conflicts)"
    echo ""

    # Check if there are staged changes to commit
    if git diff-index --quiet --cached HEAD --; then
        # Nothing staged - already up to date
        echo "ℹ️  Branch already up-to-date with main (nothing to merge)"
    else
        # Staged changes exist - commit them
        git commit -m "Squash merge of $CURRENT_BRANCH"
    fi
else
    # Conflicts detected
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "⚠️  Conflicts Detected"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Conflicting files:"
    git diff --name-only --diff-filter=U
    echo ""

    # Save conflicted files list
    git diff --name-only --diff-filter=U > "$MERGE_DIR/updatemain-conflicted-files.txt"

    # For each conflicted file, save full files AND diffs
    while IFS= read -r file; do
        if [ -n "$file" ]; then
            # Sanitize filename for directory structure
            SAFE_PATH=$(echo "$file" | sed 's/\//__/g')
            FILE_DIR="$MERGE_DIR/updatemain-$SAFE_PATH"
            mkdir -p "$FILE_DIR"

            # Save full files at each point
            git show "$FORK_POINT:$file" > "$FILE_DIR/A-forkpoint.txt" 2>/dev/null || \
                echo "(file did not exist)" > "$FILE_DIR/A-forkpoint.txt"
            git show "$FEATURE_HEAD:$file" > "$FILE_DIR/B-feature.txt" 2>/dev/null || \
                echo "(file did not exist)" > "$FILE_DIR/B-feature.txt"
            git show "$MAIN_HEAD:$file" > "$FILE_DIR/C-main.txt" 2>/dev/null || \
                echo "(file did not exist)" > "$FILE_DIR/C-main.txt"

            # Save diffs (what changed)
            git diff "$FORK_POINT" "$FEATURE_HEAD" -- "$file" > "$FILE_DIR/B-A.diff" 2>/dev/null
            git diff "$FORK_POINT" "$MAIN_HEAD" -- "$file" > "$FILE_DIR/C-A.diff" 2>/dev/null
        fi
    done < "$MERGE_DIR/updatemain-conflicted-files.txt"

    echo "✅ Merge context saved to: $MERGE_DIR"
    echo ""

    # Check for saved AI merge preference
    SAVED_AI_PREF=$(get_ai_merge_preference)
    USE_AI=""

    if [ -n "$SAVED_AI_PREF" ]; then
        # Use saved preference
        if [ "$SAVED_AI_PREF" = "yes" ]; then
            echo "Using saved preference: AI merge (from $SETTINGS_FILE)"
            echo "To change this setting, edit $SETTINGS_FILE and set \"ai_merge_conflicts\" to true/false"
            echo ""
            USE_AI="yes"
        else
            echo "Using saved preference: Manual merge (from $SETTINGS_FILE)"
            echo "To change this setting, edit $SETTINGS_FILE and set \"ai_merge_conflicts\" to true/false"
            echo ""
            USE_AI="no"
        fi
    else
        # No saved preference - ask user and save their choice
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "⚠️  Your choice will be saved to: $SETTINGS_FILE"
        echo "   You can edit this file later to change your preference."
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        read -p "Would you like AI to help resolve conflicts? (y/n) " -n 1 -r
        echo

        if [[ $REPLY =~ ^[Yy]$ ]]; then
            save_ai_merge_preference "true"
            echo "✅ Saved preference: AI merge"
            USE_AI="yes"
        else
            save_ai_merge_preference "false"
            echo "✅ Saved preference: Manual merge"
            USE_AI="no"
        fi
        echo ""
    fi

    if [ "$USE_AI" = "yes" ]; then
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "🤖 Calling AI to Resolve Conflicts"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""

        # Call Claude merge command
        # Note: Claude will calculate MERGE_DIR itself using the same formula:
        #   CURRENT_BRANCH=$(git branch --show-current)
        #   FEATURE_NAME=$(./scripts/.workflow/git-readAiBranchName.sh)
        #   MERGE_DIR="${REPO_ROOT}/webpiecesTmp/merge-${FEATURE_NAME}"
        # This is because environment variables don't carry over to interactive Claude sessions
        #
        # --allowed-tools: Pre-approves these tools so Claude can resolve conflicts
        #   without prompting for each edit. User reviews AI's work before committing.
        # --append-system-prompt: Adds instructions to system prompt
        claude \
            --allowed-tools "Edit Write Read Bash Glob Grep" \
            --append-system-prompt "Read .claude/commands/wp-merge.md and follow ALL instructions in that file to resolve the merge conflicts." \
            "Start resolving the merge conflicts now."

        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "✅ AI Merge Summary ✅"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        echo "Review what I did before committing:"
        echo "  1. Read each file's resolution details BELOW (quick read) - AI tells you bad stuff it does sometimes that you can correct"
        echo "  2. Diff each file in your IDE making sure AI did nothing extra"
        echo "  3. Delete any remaining A/B/C comment blocks in the code"
        echo ""
        echo "Full merge context available in: $MERGE_DIR"
        echo ""
        # Print the merge summary if it exists
        MERGE_SUMMARY_FILE="$MERGE_DIR/merge-summary.md"
        if [ -f "$MERGE_SUMMARY_FILE" ]; then
            cat "$MERGE_SUMMARY_FILE"
        else
            echo "ℹ️  No merge summary file was generated by AI."
            echo "   (Expected: $MERGE_SUMMARY_FILE)"
        fi
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "⚠️  IMPORTANT: SCROLL UP to AI Merge Summary section"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        echo "When done reviewing, run:"
        echo ""
        echo "  git add -A && git commit -m \"Merge main into feature branch\""
        echo ""

        # Wait for user to review and commit
        while true; do
            read -p "Have you scrolled up to ✅ AI Merge Summary ✅ and done a quick read? Did you commit it per instructions? (y/n) " -n 1 -r
            echo

            if [[ $REPLY =~ ^[Yy]$ ]]; then
                # Verify working tree is clean
                if git diff-index --quiet HEAD --; then
                    break
                else
                    echo ""
                    echo "❌ You still have uncommitted changes"
                    echo ""
                fi
            fi
        done

        # Signal that conflicts were resolved (for display after merge)
        touch "$MERGE_DIR/conflicts-resolved"

        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    else
        # Manual merge loop (USE_AI = "no")
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "🛠️  Manual Merge Required"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""

        while true; do
            echo "Please resolve conflicts manually"
            echo "Merge context available in: $MERGE_DIR"
            echo ""
            read -p "Are you done merging and committing? (y/n) " -n 1 -r
            echo

            if [[ $REPLY =~ ^[Yy]$ ]]; then
                # Verify working tree is clean
                if git diff-index --quiet HEAD --; then
                    break
                else
                    echo "❌ You still have uncommitted changes"
                    echo ""
                fi
            fi
        done

        # Signal that conflicts were resolved
        touch "$MERGE_DIR/conflicts-resolved"
    fi
fi

# ============================================================
# STEP 5: Delete Stale Feature Branch Locally
# ============================================================

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🗑️  Cleaning Up Old Branch"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "Deleting local branch: $CURRENT_BRANCH (backed up as $BACKUP_BRANCH)"
git branch -D "$CURRENT_BRANCH"
echo ""

# ============================================================
# STEP 6: Find and Update PR Using GitHub CLI
# ============================================================

# Check if remote branch exists (more reliable than PR check which can fail silently)
# PR_NUMBER was already detected at the start but gh pr list can fail silently
if git ls-remote --exit-code --heads origin "$CURRENT_BRANCH" &>/dev/null; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if [ -n "$PR_NUMBER" ]; then
        echo "🔍 Updating Existing PR #$PR_NUMBER"
    else
        echo "🔍 Updating Remote Branch (no PR found)"
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    # Remote branch exists - force push to sync it
    if [ -n "$PR_NUMBER" ]; then
        echo "✅ Updating PR #$PR_NUMBER with squashed changes"
    else
        echo "⚠️  Remote branch exists but no PR found (PR check may have failed)"
        echo "   Syncing remote branch anyway..."
    fi
    echo ""
    echo "Force pushing $SQUASH_BRANCH to origin/$CURRENT_BRANCH..."
    git push -u --force-with-lease origin "$SQUASH_BRANCH:$CURRENT_BRANCH"

    # Rename Squash to feature branch
    git checkout "$SQUASH_BRANCH"
    git branch -m "$CURRENT_BRANCH"

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if [ -n "$PR_NUMBER" ]; then
        echo "✅ Successfully Updated PR #$PR_NUMBER"
    else
        echo "✅ Successfully Updated Remote Branch"
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "📋 Summary:"
    echo "  Branch: $CURRENT_BRANCH"
    if [ -n "$PR_NUMBER" ]; then
        echo "  PR: #$PR_NUMBER"
    else
        echo "  PR: (none found - create with gh pr create)"
    fi
    echo "  Backup: $BACKUP_BRANCH"
    echo "  Merge context: $MERGE_DIR"
    echo ""
    echo "Next steps:"
    echo "  1. Review changes on GitHub"
    echo "  2. Continue development or create more commits"
    echo "  3. Delete old backup when safe: git branch -D $BACKUP_BRANCH"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
else
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📝 No Remote Branch to Update"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    # No remote branch - just rename locally (will be pushed by gh pr create later)
    git checkout "$SQUASH_BRANCH"
    git branch -m "$CURRENT_BRANCH"

    echo "ℹ️  No remote branch found for $CURRENT_BRANCH (local only)"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "✅ Branch Updated from Main"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "📋 Summary:"
    echo "  Branch: $CURRENT_BRANCH"
    echo "  Base: main (latest)"
    echo "  Backup: $BACKUP_BRANCH"
    echo "  Merge context: $MERGE_DIR"
    echo ""
    echo "Next steps:"
    echo "  1. Test your changes"
    echo "  2. Create PR with: gh pr create"
    echo "  3. Delete old backup when safe: git branch -D $BACKUP_BRANCH"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
fi

# ============================================================
# Cleanup: Remove old temporary directories (30+ days)
# ============================================================
SCRIPT_DIR="$(cd "$(dirname "$0")/.workflow" && pwd)"
"$SCRIPT_DIR/cleanTmp.sh"
