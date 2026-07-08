import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    WEBPIECES_TMP_DIR, MERGE_EXPLANATION_FILE, CliExitError,
    MutationVerb, BranchMutationEvent, logBranchMutation,
} from '@webpieces/rules-config';
import { gatherInfo } from '../git-gatherInfo';
import { baseBranchName, nextFreePreMergeNumber, preMergeBackupName } from './branch-naming';
import { runGitChecked } from './git-exec';
import { MergeMarker, perFileContextDir, writeMergeMarker, mergeRunDirFor } from './merge-state';

// merge-START: the first half of the 3-point squash-merge lifecycle. Brings origin/main into a fresh
// `<branch>Squash`, and on conflict writes the 3-point context files + the unvalidated marker + the
// process doc, then hands control back to the AI. On a clean merge it commits the squash and returns
// the branch context so the caller (runUpdateFromMain) can run merge-END to finalize. It NEVER
// finalizes or posts a PR — that is merge-END's / wp-finish-upsert-pr's job. Shared so
// runUpdateFromMain (and, via it, wp-update-start + wp-start-upsert-pr) all set up a merge through
// one code path. `finishCommand` names the command the AI runs to finish after resolving conflicts
// (standalone update → `wp-update-end`; PR flow → `wp-finish-upsert-pr`).

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

interface HashPoints {
    hashForkPoint: string;
    hashFeatureHead: string;
    hashMainHead: string;
}

// The four branch names merge-END needs to finalize a merge (swap squash→feature, push, clean up).
export class MergeContext {
    currentBranch: string;
    squashBranch: string;
    backupBranch: string;
    prNumber: string;

    constructor(currentBranch: string, squashBranch: string, backupBranch: string, prNumber: string) {
        this.currentBranch = currentBranch;
        this.squashBranch = squashBranch;
        this.backupBranch = backupBranch;
        this.prNumber = prNumber;
    }
}

// Outcome of merge-start: 'clean' carries the context for merge-END to finalize; 'conflict' means the
// marker + context files were written and the caller should hand back to the AI (exit 2).
export class MergeStartResult {
    status: 'clean' | 'conflict';
    context: MergeContext | null;
    runDir: string; // this sync's numbered `merge-<n>/` dir — passed to merge-END so it reads THIS marker

    constructor(status: 'clean' | 'conflict', context: MergeContext | null, runDir: string) {
        this.status = status;
        this.context = context;
        this.runDir = runDir;
    }
}

// Detect the PR by its STABLE feature branch — pass baseBranchName(currentBranch) so a leftover
// `…wpN` from the old scheme still resolves to the one name the PR lives on.
function detectPr(baseBranch: string): string {
    const result = spawnSync(
        'gh', ['pr', 'list', '--head', baseBranch, '--json', 'number', '--jq', '.[0].number'],
        { encoding: 'utf8' },
    );
    return result.status === 0 ? (result.stdout ?? '').trim() : '';
}

// The one number `n` for a sync and the two things it names: the pre-merge backup branch and its
// paired conflict-context run dir.
class SyncSlot {
    backupBranch: string;
    runDir: string;

    constructor(backupBranch: string, runDir: string) {
        this.backupBranch = backupBranch;
        this.runDir = runDir;
    }
}

// Pick the first free `<branch>PreMerge<n>` slot number, then WIPE the paired `<home>/merge-<n>/` run
// dir — a fresh sync means no merge is in progress, so any leftover `merge-<n>` is stale (its own sync
// ended, or its branch was deleted) and MUST NOT leak its old per-file merge-explanation.md into this
// merge's validation. Returns the backup branch name + the (now-empty) run dir path, both keyed on `n`.
function chooseSyncSlot(home: string, currentBranch: string): SyncSlot {
    const n = nextFreePreMergeNumber(
        currentBranch,
        (name: string): boolean => spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).status === 0,
    );
    const runDir = mergeRunDirFor(home, n);
    fs.rmSync(runDir, { recursive: true, force: true });
    return new SyncSlot(preMergeBackupName(currentBranch, n), runDir);
}

// Snapshot the pre-merge state onto the caller-chosen `backupBranch` (`<currentBranch>PreMerge<n>`),
// never overwriting. The slot number `n` is picked once in mergeStart and shared with the paired
// `merge-<n>/` context dir. A clean sync deletes this snapshot at finalize; only conflict syncs keep it.
function createBackup(currentBranch: string, backupBranch: string): void {
    process.stdout.write('\n' + SEP + '💾 Creating Pre-Merge Backup\n' + SEP + '\n');
    runGitChecked(['checkout', '-b', backupBranch], 'Failed to create backup branch');
    runGitChecked(['checkout', currentBranch], 'Failed to return to feature branch');
    process.stdout.write(`✅ Backup created: ${backupBranch}\n\n`);
}

function saveConflictContext(
    conflictedFiles: string[], mergeDir: string, forkPoint: string, featureHead: string, mainHead: string,
): void {
    for (const file of conflictedFiles) {
        const fileDir = perFileContextDir(mergeDir, file);
        fs.mkdirSync(fileDir, { recursive: true });

        const fork = spawnSync('git', ['show', `${forkPoint}:${file}`], { encoding: 'utf8' });
        fs.writeFileSync(path.join(fileDir, 'A-forkpoint.txt'), fork.status === 0 ? (fork.stdout ?? '') : '(file did not exist)\n');
        const feature = spawnSync('git', ['show', `${featureHead}:${file}`], { encoding: 'utf8' });
        fs.writeFileSync(path.join(fileDir, 'B-feature.txt'), feature.status === 0 ? (feature.stdout ?? '') : '(file did not exist)\n');
        const main = spawnSync('git', ['show', `${mainHead}:${file}`], { encoding: 'utf8' });
        fs.writeFileSync(path.join(fileDir, 'C-main.txt'), main.status === 0 ? (main.stdout ?? '') : '(file did not exist)\n');

        const ba = spawnSync('git', ['diff', forkPoint, featureHead, '--', file], { encoding: 'utf8' });
        fs.writeFileSync(path.join(fileDir, 'B-A.diff'), ba.stdout ?? '');
        const ca = spawnSync('git', ['diff', forkPoint, mainHead, '--', file], { encoding: 'utf8' });
        fs.writeFileSync(path.join(fileDir, 'C-A.diff'), ca.stdout ?? '');
    }
}

// Single source of truth for the merge process. The script WRITES it at conflict time (rather
// than the AI relying on a separate hand-maintained doc), parameterized with the live MERGE_DIR
// and conflicted-file list, so the instructions can never drift from the actual layout. The body
// is a template constant with {{...}} placeholders so this stays a small filler function.
const MERGE_PROCESS_TEMPLATE = `# AI-Assisted Squash-Merge Conflict Resolution (generated)

This file was generated by \`pnpm wp-update-start\` when the 3-point squash-merge hit conflicts.
It is the single source of truth for the merge process — follow it exactly.

You are on branch \`{{SQUASH_BRANCH}}\` with conflict markers in the working tree.
\`MERGE_DIR = {{MERGE_DIR}}\`

## How the gate works

- Resolve every conflicted file in the working tree.
- Run **\`pnpm {{FINISH_COMMAND}}\`** — the validation + finish gate. It scans for leftover conflict
  markers, checks each conflicted file has a written merge explanation, validates, and commits the
  merge. (In the PR flow this command is \`wp-finish-upsert-pr\`, which additionally runs the
  \`nx affected\` build, renders the dashboard, and creates/updates the PR.)
- **Do NOT run \`git add\` / \`git commit\` / \`git push\` / \`gh pr\` yourself.** They are blocked by
  the \`merge-in-progress-guard\` hook until the gate validates. The gate does the commit.

## STEP 1 — Load the merge context

Per conflicted file, \`MERGE_DIR/updatemain-<safe_path>/\` holds (\`<safe_path>\` = path with \`/\`→\`__\`):

\`\`\`
A-forkpoint.txt   # file at fork point (base)
B-feature.txt     # file on your feature branch
C-main.txt        # file on main
B-A.diff          # what your feature changed (B−A)
C-A.diff          # what main changed (C−A)
\`\`\`

\`updatemain-hashes.json\` holds A/B/C commit hashes. To see why main changed:
\`git log <A>..<C> --oneline\`.

## STEP 2 — Resolve each conflicted file

For each file: read the working-tree file (the markers) and its \`B-A.diff\` / \`C-A.diff\` (intent),
then Edit to the resolved version, removing ALL conflict markers.

Strategies: goals align & non-overlapping → merge both · one side removes what the other modifies
→ prefer the removal · same lines, simple (imports/format) → merge both · same lines, complex or
conflicting goals → ask the user · feature re-implements what main already squashed → prefer
main's, then re-apply only the genuinely new feature work.

**Then write a merge explanation** for each conflicted file — NOT a comment in the source (that
breaks for JSON and deleted files). Write it next to that file's diffs, at:

\`\`\`
MERGE_DIR/updatemain-<safe_path>/{{EXPLANATION_FILE}}
\`\`\`

(\`<safe_path>\` = the conflict file path with \`/\` → \`__\`, the same dir that holds its
\`A-forkpoint.txt\` / \`B-A.diff\` / \`C-A.diff\`.) In it, explain in a few sentences how you resolved
this file: which side you took where, what you combined from B-A.diff vs C-A.diff, and why. The
gate fails if any conflicted file's explanation is missing or empty. Do not paste A/B/C context
blocks into the source code.

## STEP 3 — Run the gate (validates the merge AND finalizes it)

\`\`\`
pnpm {{FINISH_COMMAND}}
\`\`\`

- Leftover conflict markers → fix those files and re-run.
- Missing merge explanation → write it (see STEP 2) and re-run.
- Build failure → fix the TypeScript/lint errors and re-run (the gate re-stages for you).
- Missing review.json (PR flow only) → write it in the printed format (your PR review), then re-run.
- On success it commits and finalizes the merge (in the PR flow it also renders the dashboard and
  creates/updates the PR).

## Conflicted files

{{FILE_LIST}}

## If you need to bail out

A numbered backup branch was created (e.g. \`<feature>PreMerge1\`). To abandon:

\`\`\`
git merge --abort 2>/dev/null; git checkout <feature> ; git branch -D {{SQUASH_BRANCH}}
\`\`\`

Then delete \`{{MERGE_DIR}}/\` for a clean slate.
`;

function mergeProcessDoc(mergeDir: string, squashBranch: string, conflictedFiles: string[], finishCommand: string): string {
    const fileList = conflictedFiles.map((f: string): string => `- \`${f}\``).join('\n');
    return MERGE_PROCESS_TEMPLATE
        .replace(/\{\{SQUASH_BRANCH\}\}/g, squashBranch)
        .replace(/\{\{MERGE_DIR\}\}/g, mergeDir)
        .replace(/\{\{EXPLANATION_FILE\}\}/g, MERGE_EXPLANATION_FILE)
        .replace(/\{\{FINISH_COMMAND\}\}/g, finishCommand)
        .replace(/\{\{FILE_LIST\}\}/g, fileList);
}

// Returns the absolute path of the written doc.
function writeMergeProcessDoc(repoRoot: string, mergeDir: string, squashBranch: string, conflictedFiles: string[], finishCommand: string): string {
    const docDir = path.join(repoRoot, WEBPIECES_TMP_DIR, 'instruct-ai');
    fs.mkdirSync(docDir, { recursive: true });
    const docPath = path.join(docDir, 'webpieces.mergeprocess.md');
    fs.writeFileSync(docPath, mergeProcessDoc(mergeDir, squashBranch, conflictedFiles, finishCommand));
    return docPath;
}

// The AI-facing "what just happened / what to do next" recap on the conflict path. Explicit and
// numbered so an agent (or human) can't miss where the context lives or which command finishes.
function printConflictHandback(
    docPath: string, mergeDir: string, squashBranch: string, conflictedFiles: string[], finishCommand: string,
): void {
    process.stdout.write('\n' + SEP + `⚠️  Conflicts in ${conflictedFiles.length} file(s) — handing control back to you\n` + SEP + '\n');
    process.stdout.write('Here is exactly what I did and what you need to do:\n\n');
    process.stdout.write('What I did:\n');
    process.stdout.write('   1. snapshotted your pre-merge state to a PreMerge branch\n');
    process.stdout.write('   2. pulled origin/main and squash-merged your work onto it\n');
    process.stdout.write(`   3. hit conflicts — you are now on the transient branch  ${squashBranch}\n\n`);
    process.stdout.write('What you need to do:\n');
    process.stdout.write(`   1. read the merge process doc:  ${docPath}\n`);
    process.stdout.write(`   2. resolve each conflicted file below (its 3-point A/B/C context + diffs are in\n`);
    process.stdout.write(`      ${mergeDir}/updatemain-<file>/), and write that file's merge-explanation.md\n`);
    process.stdout.write(`   3. run  pnpm ${finishCommand}  — it validates, commits, and finalizes (do NOT git add/commit/push yourself)\n\n`);
    process.stdout.write('Conflicted files:\n');
    for (const file of conflictedFiles) process.stdout.write(`  - ${file}\n`);
    process.stdout.write('\n' + SEP);
}

// Write the conflict context files + the unvalidated marker + the process doc. Does NOT exit — the
// caller decides (runUpdateFromMain exits 2 to hand back to the AI).
function handleConflictsHandback(
    repoRoot: string, mergeDir: string, currentBranch: string, squashBranch: string,
    backupBranch: string, prNumber: string, hashes: HashPoints, finishCommand: string,
): void {
    const raw = execSync('git diff --name-only --diff-filter=U', { encoding: 'utf8' }).trim();
    const conflictedFiles = raw.split('\n').filter((f: string): boolean => f.trim() !== '');
    fs.mkdirSync(mergeDir, { recursive: true }); // run dir was wiped at sync start — create it fresh
    fs.writeFileSync(path.join(mergeDir, 'updatemain-conflicted-files.txt'), raw + '\n');
    // Copy the A/B/C hashes into THIS run dir so the merge-process doc's `MERGE_DIR/updatemain-hashes.json`
    // pointer is accurate (gatherInfo writes the source copy into the feature home before the slot is known).
    fs.writeFileSync(path.join(mergeDir, 'updatemain-hashes.json'), JSON.stringify(hashes, null, 2) + '\n');
    saveConflictContext(conflictedFiles, mergeDir, hashes.hashForkPoint, hashes.hashFeatureHead, hashes.hashMainHead);

    const marker = new MergeMarker(
        currentBranch, squashBranch, backupBranch, prNumber, conflictedFiles,
        hashes.hashForkPoint, hashes.hashFeatureHead, hashes.hashMainHead, false,
    );
    writeMergeMarker(mergeDir, marker);
    const docPath = writeMergeProcessDoc(repoRoot, mergeDir, squashBranch, conflictedFiles, finishCommand);
    printConflictHandback(docPath, mergeDir, squashBranch, conflictedFiles, finishCommand);
}

// Short sha of a ref (best-effort — '' if it can't resolve), for the branch-mutation log's
// oldMain→newMain annotation.
function shortSha(ref: string): string {
    const result = spawnSync('git', ['rev-parse', '--short', ref], { encoding: 'utf8' });
    return result.status === 0 ? (result.stdout ?? '').trim() : '';
}

// Log the CONFLICT phase with the conflicted-file list + the artifact paths a resolver needs — the
// per-file 3-point context dir and the generated merge-process doc — so the branch-mutation log alone
// tells the next agent where to look (no reflog/log archaeology).
function logConflict(repoRoot: string, verb: MutationVerb, mergeDir: string): void {
    const raw = spawnSync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: repoRoot, encoding: 'utf8' });
    const files = (raw.status === 0 ? (raw.stdout ?? '') : '').split('\n').map((f: string): string => f.trim()).filter((f: string): boolean => f !== '');
    const event = new BranchMutationEvent(verb, 'CONFLICT');
    event.conflict = true;
    event.conflictFiles = files;
    event.artifacts = [
        path.join(mergeDir, 'updatemain-<file>'),
        path.join(repoRoot, WEBPIECES_TMP_DIR, 'instruct-ai', 'webpieces.mergeprocess.md'),
    ];
    logBranchMutation(repoRoot, event);
}

export async function mergeStart(repoRoot: string, verb: MutationVerb, home: string, finishCommand: string): Promise<MergeStartResult> {
    const currentBranch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
    if (currentBranch.endsWith('Squash')) {
        throw new CliExitError(1, `❌ On a leftover ${currentBranch} branch with no merge marker. Clean up: git branch -D ${currentBranch}`);
    }

    // One number `n` for this sync drives BOTH the backup branch and its `merge-<n>/` context dir.
    const slot = chooseSyncSlot(home, currentBranch);
    const backupBranch = slot.backupBranch;
    const mergeDir = slot.runDir;

    process.stdout.write('\n' + SEP + '🔄 Squash-Merge Update from Main\n' + SEP + '\n');
    // gatherInfo RETURNS (never exits): an already-even-with-main branch is NOT special-cased here —
    // we flow straight on. The squash merge below becomes a no-op that the `nothingStaged` path
    // (further down) handles, so the caller still proceeds to push + build. (Previously gatherInfo
    // process.exit(0)'d on this case, silently killing wp-start-upsert-pr before push/build.)
    const info = await gatherInfo();
    const hashes = info.hashes;
    if (info.alreadyUpToDate) {
        process.stdout.write('ℹ️  Branch already even with main; nothing to merge, continuing to push/build.\n');
    }

    const prNumber = detectPr(baseBranchName(currentBranch));
    process.stdout.write(prNumber ? `Existing PR #${prNumber} will be updated.\n` : 'No existing PR (one can be created later).\n');

    createBackup(currentBranch, backupBranch);
    const backupEvent = new BranchMutationEvent(verb, 'BACKUP');
    backupEvent.fromBranch = currentBranch;
    backupEvent.toBranch = backupBranch;
    logBranchMutation(repoRoot, backupEvent);

    const squashBranch = `${currentBranch}Squash`;
    if (spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${squashBranch}`]).status === 0) {
        throw new CliExitError(1, `❌ Stale ${squashBranch} from a previous run. Delete it: git branch -D ${squashBranch}`);
    }

    // Branch the squash off origin/main directly — worktree-native. Never checks out or mutates local
    // `main`, which fatals inside a linked worktree (`git checkout main` → "'main' is already checked
    // out at <primary>"). origin/main was already fetched in gatherInfo() above, and the fork point +
    // all three hash points (A/B/C) are computed purely from origin/main, so the squash merge base is
    // identical to the old checkout-main + pull path — this is a behavior-preserving change on the
    // primary repo and an unblock inside worktrees.
    const originMainSha = shortSha('origin/main');
    runGitChecked(['checkout', '-b', squashBranch, 'origin/main'], 'Failed to create squash branch off origin/main');
    const baseEvent = new BranchMutationEvent(verb, 'PULL');
    baseEvent.newMain = originMainSha;
    logBranchMutation(repoRoot, baseEvent);

    process.stdout.write('\n' + SEP + `🔀 Squash merging ${currentBranch}\n` + SEP + '\n');
    const merge = spawnSync('git', ['merge', '--squash', currentBranch], { stdio: 'inherit' });
    if (merge.status !== 0) {
        handleConflictsHandback(repoRoot, mergeDir, currentBranch, squashBranch, backupBranch, prNumber, hashes, finishCommand);
        logConflict(repoRoot, verb, mergeDir);
        return new MergeStartResult('conflict', null, mergeDir);
    }
    logBranchMutation(repoRoot, new BranchMutationEvent(verb, 'SQUASH'));

    const nothingStaged = spawnSync('git', ['diff-index', '--quiet', '--cached', 'HEAD', '--']).status === 0;
    if (nothingStaged) {
        process.stdout.write('ℹ️  Already up-to-date with main (nothing to merge).\n');
    } else {
        runGitChecked(['commit', '-m', `Squash merge of ${currentBranch}`], 'Failed to commit squash merge');
    }
    return new MergeStartResult('clean', new MergeContext(currentBranch, squashBranch, backupBranch, prNumber), mergeDir);
}
