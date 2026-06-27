# AI-Assisted Squash Merge Conflict Resolution

⚠️ **WARNING: AI is less stable than scripts**

For a more stable merge experience, run our script which helps AI:

- `./scripts/git-updateFromMain.sh`

This script sets up the environment properly before launching AI, resulting in more stable merges.

---

You are helping resolve merge conflicts in a squash-merge workflow where the feature branch is being merged with the latest main.

## Context Provided by git-updateFromMain.sh

The script has already:

- Created a Squash branch from latest main
- Attempted to squash merge the feature branch
- Detected conflicts
- Saved rich merge context to persistent workspace tmp

## Your Mission

Resolve all merge conflicts intelligently by analyzing what each branch was trying to achieve, then commit the merge.

## Execution Steps

### STEP 1: Calculate and Load Merge Context

**1.1 Get the feature name:**

- Run `./scripts/.workflow/git-readAiBranchName.sh` using Bash tool to get FEATURE_NAME
- This returns the sanitized branch name (with "Squash" suffix stripped if present)

**1.2 Calculate merge directory path:**

- MERGE_DIR = `${REPO_ROOT}/webpiecesTmp/merge-${FEATURE_NAME}`
- Example: `${REPO_ROOT}/webpiecesTmp/merge-deanhiller-my-feature`

**1.3 Context files in MERGE_DIR:**

```
updatemain-hashes.json                          # Hash points (A, B, C) - GOLD STANDARD
updatemain-conflicted-files.txt                 # List of files with conflicts
updatemain-{safe_path}/A-forkpoint.txt          # File at fork point (A)
updatemain-{safe_path}/B-feature.txt            # File on feature branch (B)
updatemain-{safe_path}/C-main.txt               # File on main branch (C)
updatemain-{safe_path}/B-A.diff                 # What changed in feature (B - A)
updatemain-{safe_path}/C-A.diff                 # What changed in main (C - A)
```

Where `{safe_path}` = original file path with `/` replaced by `__`
Example: `src/api/handler.ts` → `updatemain-src__api__handler.ts`

**1.4 Load hash points:**

- Use Read tool on `${MERGE_DIR}/updatemain-hashes.json`
- Extract:
    - HASH_A = `.hashForkPoint` (where feature branched from main)
    - HASH_B = `.hashFeatureHead` (tip of feature branch)
    - HASH_C = `.hashMainHead` (current main branch tip)

**1.5 Load conflicted files list:**

- Use Read tool on `${MERGE_DIR}/updatemain-conflicted-files.txt`
- This gives you the list of files with merge conflicts

**1.6 Analyze Main Branch Commits for Context:**

Before resolving conflicts, understand what happened on main while the feature was being developed:

- Use Bash tool to see commit messages between fork point (A) and main HEAD (C):
    ```bash
    git log ${HASH_A}..${HASH_C} --oneline
    ```
- This shows the INTENT behind main's changes (WHY changes were made)
- The per-file diffs (B-A.diff, C-A.diff) show WHAT changed; the commit log shows WHY
- For more detail on specific areas, you can read the full diff:
    ```bash
    git diff ${HASH_A}..${HASH_C} -- path/to/specific/file
    ```
- This context helps make better merge decisions, especially when:
    - Main has multiple PRs merged that affect the same areas
    - Understanding if feature changes duplicate what main already did
    - Deciding whether to prefer main's version or merge both approaches

### STEP 2: Resolve Each Conflicted File

For each conflicting file, follow this process:

#### 2.1 Analyze the Context

For each file in the conflicted files list:

**Step 1: Read the conflicted file from working directory**

- Use Read tool on the actual file path to see the conflict markers
- Example: `Read("packages/http/http-routing/src/decorators.ts")`

**Step 2: Calculate the safe path for this file**

- Replace `/` with `__` in the file path
- Example: `packages/http/http-routing/src/decorators.ts` → `packages__http__http-routing__src__decorators.ts`

**Step 3: Read merge context files using Read tool**

- Use Read tool to access these files in `${MERGE_DIR}/updatemain-{safe-path}/`:
    - `A-forkpoint.txt` - File at fork point (A)
    - `B-feature.txt` - File on feature branch (B)
    - `C-main.txt` - File on main branch (C)
    - `B-A.diff` - What changed on feature branch (FEATURE CHANGES)
    - `C-A.diff` - What changed on main branch (MAIN CHANGES)

**Step 4: Analyze the diffs to understand GOALS**

- **B-A.diff**: What did the feature branch try to achieve?
- **C-A.diff**: What did main branch try to achieve?
- Do the goals align or conflict?
- Can both changes coexist?

#### 2.2 Decide Whether to Insert Diff Comments

**Only if BOTH diffs are < 8 lines each:**

Insert the diffs as inline comments at the top of the resolved file:

```typescript
// ═══════════════════════════════════════════════════════════════════════════
// MERGE CONTEXT - DELETE AFTER REVIEWING
// Full context: ${REPO_ROOT}/webpiecesTmp/merge-my-feature/updatemain-src__api__handler.ts/
// ═══════════════════════════════════════════════════════════════════════════
//
// ═══ FEATURE BRANCH CHANGES (B-A) - {short-hash of HASH_B} ═══
// {insert B-A.diff here, each line prefixed with "// "}
//
// ═══ MAIN BRANCH CHANGES (C-A) - {short-hash of HASH_C} ═══
// {insert C-A.diff here, each line prefixed with "// "}
//
// ═══════════════════════════════════════════════════════════════════════════

{resolved code here}
```

**If either diff is > 8 lines:**

Just add a reference comment at the top:

```typescript
// See merge context: ${REPO_ROOT}/webpiecesTmp/merge-my-feature/updatemain-src__api__handler.ts/

{resolved code here}
```

#### 2.3 Resolve the Conflict

Use the Edit tool to replace the entire file with the resolved version.

**Resolution strategies:**

- **Goals align, changes non-overlapping**: Merge both changes
- **One side removes what other modifies**: Prefer the removal (code was deleted for a reason)
- **Both sides change same lines differently**:
    - If simple (imports, formatting): Merge both intelligently
    - If complex (business logic): Ask user with full context
- **Goals directly conflict**: Ask user with explanation of both goals
- **Duplicate changes detected (Step branches)**:
    - Feature branch shows: individual commits implementing a feature
    - Main branch shows: squashed commit with same logical changes
    - **PREFER MAIN'S VERSION** - it may contain fixes or refinements from code review
    - Only apply the truly NEW work from feature branch (commits after the duplicate)
    - Example: Feature has E,F,G,C,U,T,S; Main has X (squashed E,F,G,C); Apply only U,T,S

**When to ask user:**

- Conflicting business logic goals
- Contradictory behavior changes
- Security-sensitive changes
- Complex refactors that overlap

**What NOT to ask user:**

- Import conflicts (merge both)
- Formatting differences (use consistent style)
- Simple variable renames
- Non-overlapping changes

#### 2.4 Track Progress

After resolving each file, show progress:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔧 Resolving Conflicts
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ src/api/handler.ts (merged imports)
✅ src/config/settings.ts (kept main's refactor + feature's new setting)
🔧 src/components/UserList.tsx (resolving...)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### STEP 3: Stage Changes

After all conflicts are resolved:

**3.1 Stage all resolved files:**

- Use Bash tool: `./scripts/git-mergeComplete.sh`
- This will stage all changes with `git add -A`

### STEP 4: Validate Build

Before requesting human review, validate that the merge compiles:

**4.1 Run the build validation:**

- Use Bash tool: `pnpm run build-all`
- This validates TypeScript compilation, ESLint, and all package checks

**4.2 If build fails:**

- Analyze the error messages
- Fix any TypeScript errors, import issues, or type mismatches
- Re-stage fixed files with `git add <file>`
- Run `pnpm run build-all` again
- Repeat until build passes

**4.3 Track validation progress:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔨 Build Validation
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ pnpm run build-all passed
[List any errors that were fixed, if any]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### STEP 4.6: Generate Merge Summary

After build validation passes, generate a summary of the merge for developer review.

**4.6.1 Create merge summary file:**

Use the Write tool to create `${MERGE_DIR}/merge-summary.md` with the following structure:

```markdown
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Merge Conflicts Resolved - BUILD PASSED - HUMAN REVIEW REQUIRED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 Files Resolved:
✅ {file1} ({brief resolution note})
✅ {file2} ({brief resolution note})
...

📋 Resolution Details:

{file1}:

- Conflict type: {imports/logic/structure/other}
- Feature goal: {what the feature branch was trying to do}
- Main goal: {what the main branch was trying to do}
- Resolution: {how you resolved it and why}

{file2}:
...

📋 Additional Fixes Applied:
✅ {any fixes beyond conflict resolution, if any}
(or "None" if no additional fixes were needed)

📋 Main Branch Changes (A to C):
{Output from git log A..C --oneline, showing what was merged to main}

📋 Build Validation:
✅ pnpm run build-all passed
```

**4.6.2 Create signal file for display after merge:**

Use Bash tool to create a signal file:

```bash
touch ${MERGE_DIR}/conflicts-resolved
```

This file signals that conflicts were detected and resolved.

### STEP 5: Request Human Review and Approval

The merge-summary.md file you created in STEP 4.6.1 will be displayed by the script.
After that displays, the script will show instructions about scrolling up and reviewing.

**IMPORTANT:** AI should NEVER call `git commit`. The human must review and commit manually.

## Example Resolution

Here's an example of resolving a file with small diffs:

**File:** `src/api/handler.ts`

**B-A.diff (6 lines):**

```diff
+import { validateRequest } from '../utils/validation';
+
 export function handleRequest(req: Request) {
+  validateRequest(req);
   return processRequest(req);
```

**C-A.diff (4 lines):**

```diff
+import { logger } from '../utils/logger';
+
 export function handleRequest(req: Request) {
+  logger.info('Handling request');
   return processRequest(req);
```

**Resolution (both diffs < 8 lines, so insert as comments):**

```typescript
// ═══════════════════════════════════════════════════════════════════════════
// MERGE CONTEXT - DELETE AFTER REVIEWING
// Full context: ${REPO_ROOT}/webpiecesTmp/merge-my-feature/updatemain-src__api__handler.ts/
// ═══════════════════════════════════════════════════════════════════════════
//
// ═══ FEATURE BRANCH CHANGES (B-A) - a1b2c3d ═══
// +import { validateRequest } from '../utils/validation';
// +
//  export function handleRequest(req: Request) {
// +  validateRequest(req);
//    return processRequest(req);
//
// ═══ MAIN BRANCH CHANGES (C-A) - e4f5g6h ═══
// +import { logger } from '../utils/logger';
// +
//  export function handleRequest(req: Request) {
// +  logger.info('Handling request');
//    return processRequest(req);
//
// ═══════════════════════════════════════════════════════════════════════════

import { logger } from '../utils/logger';
import { validateRequest } from '../utils/validation';

export function handleRequest(req: Request) {
    logger.info('Handling request');
    validateRequest(req);
    return processRequest(req);
}
```

**Reasoning**: Both goals align (adding logging and validation). Changes don't conflict. Merged both imports alphabetically and both function calls in logical order (log first, then validate).

## Error Handling

If something goes wrong, tell the user they can manually resolve or abort with:

```
git reset --hard {CURRENT_BRANCH}Backup1
```

## Important Reminders

✅ **Use Read tool** to access all files in MERGE_DIR
✅ **Use Bash tool** only for git commands (git add) and validation scripts
✅ **Calculate safe path** by replacing `/` with `__` in file paths
✅ **Analyze both diffs** (B-A.diff and C-A.diff) to understand goals
✅ **Insert diff comments** if both < 8 lines (helps user review)
✅ **Use Edit tool** to resolve conflicts with merged code
✅ **Run `pnpm run build-all`** after resolving - fix errors until it passes
✅ **Remind user** to delete comment blocks

❌ **Don't resolve based only on conflict markers** - analyze the diffs!
❌ **Don't guess at complex business logic** - ask the user
❌ **Don't skip analyzing goals** - understand what each branch wanted
❌ **Don't skip build validation** - merge isn't ready for review until build passes

## Begin Execution

Start with STEP 1: Calculate MERGE_DIR and load context using Read tool.
