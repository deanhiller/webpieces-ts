import * as fs from 'fs';
import * as path from 'path';
import { dotWebpieces, GitProcessApi, NativeProcessApi } from '@webpieces/tooling-common';
import { CliExitError, SyncFlowGuidance, MERGE_PROCESS_DOC, MergeProcessText, MergeRun, loadTemplate } from '@webpieces/rules-config';
import { MutationVerb, BranchMutationEvent, logBranchMutation } from '@webpieces/repo-workflow-core';
import { injectable, bindingScopeValues } from 'inversify';
import { GatherInfo } from '../git-gatherInfo';
import { BranchNaming } from './branch-naming';
import { GitExec } from './git-exec';
import { MergeState, MergeMarker } from './merge-state';

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

// The one number `n` for a sync and the things it names: the pre-merge backup branch, its paired
// conflict-context run dir, and (via `n`) the `preMerge<n>.hash` record of the tip it snapshotted.
class SyncSlot {
    backupBranch: string;
    runDir: string;
    n: number;

    constructor(backupBranch: string, runDir: string, n: number) {
        this.backupBranch = backupBranch;
        this.runDir = runDir;
        this.n = n;
    }
}


// merge-START: the first half of the 3-point squash-merge lifecycle. Brings origin/main into a fresh
// `<branch>Squash`, and on conflict writes the 3-point context + unvalidated marker + process doc,
// then hands control back to the AI. On a clean merge it commits the squash and returns the branch
// context so the caller (RunUpdate) can run merge-END to finalize. NEVER finalizes or posts a PR.
@injectable(bindingScopeValues.Singleton)
export class MergeStart {
    constructor(
        private readonly gatherInfo: GatherInfo,
        private readonly branchNaming: BranchNaming,
        private readonly gitExec: GitExec,
        private readonly mergeState: MergeState,
        private readonly git: GitProcessApi,
        private readonly processes: NativeProcessApi,
    ) {}

    async mergeStart(repoRoot: string, verb: MutationVerb, home: string, finishCommand: string): Promise<MergeStartResult> {
        const currentBranch = await this.gitExec.currentBranch(process.cwd());
        if (currentBranch.endsWith('Squash')) {
            throw new CliExitError(1, `❌ On a leftover ${currentBranch} branch with no merge marker. Clean up: git branch -D ${currentBranch}`);
        }

        // One number `n` for this sync drives BOTH the backup branch and its `merge-<n>/` context dir.
        const slot = await this.chooseSyncSlot(home, currentBranch);
        const backupBranch = slot.backupBranch;
        const mergeDir = slot.runDir;

        process.stdout.write('\n' + SEP + '🔄 Squash-Merge Update from Main\n' + SEP + '\n');
        const info = await this.gatherInfo.gatherInfo();
        const hashes = info.hashes;
        if (info.alreadyUpToDate) {
            process.stdout.write('ℹ️  Branch already even with main; nothing to merge, continuing to push/build.\n');
        }

        const prNumber = await this.detectPr(this.branchNaming.baseBranchName(currentBranch));
        process.stdout.write(prNumber ? `Existing PR #${prNumber} will be updated.\n` : 'No existing PR (one can be created later).\n');

        await this.createBackup(currentBranch, backupBranch);
        // Record THIS sync's pre-merge tip as `staged/<feature>/preMerge<n>.hash` — every intermediate
        // state, not just the last one. It is what lets the `<feature>PreMerge<n>` snapshot BRANCH be
        // disposable (branches count toward the branch cap; a written-down hash does not), and it is the
        // ref the archive tag is cut from when the PR lands.
        this.mergeState.writePreMergeHash(home, slot.n, await this.fullSha(currentBranch));
        const backupEvent = new BranchMutationEvent(verb, 'BACKUP');
        backupEvent.fromBranch = currentBranch;
        backupEvent.toBranch = backupBranch;
        logBranchMutation(repoRoot, backupEvent);

        const squashBranch = `${currentBranch}Squash`;
        if (await this.branchExists(squashBranch)) {
            throw new CliExitError(1, `❌ Stale ${squashBranch} from a previous run. Delete it: git branch -D ${squashBranch}`);
        }

        // Branch the squash off origin/main directly — worktree-native. origin/main was already fetched
        // in gatherInfo(), and A/B/C are computed purely from origin/main, so the merge base is identical
        // to the old checkout-main + pull path.
        const originMainSha = await this.shortSha('origin/main');
        await this.gitExec.runGitChecked(['checkout', '-b', squashBranch, 'origin/main'], 'Failed to create squash branch off origin/main');
        const baseEvent = new BranchMutationEvent(verb, 'PULL');
        baseEvent.newMain = originMainSha;
        logBranchMutation(repoRoot, baseEvent);

        process.stdout.write('\n' + SEP + `🔀 Squash merging ${currentBranch}\n` + SEP + '\n');
        const merge = await this.git.passThrough(['merge', '--squash', currentBranch]);
        if (!merge.ok) {
            await this.handleConflictsHandback(repoRoot, mergeDir, currentBranch, squashBranch, backupBranch, prNumber, hashes, finishCommand);
            await this.logConflict(repoRoot, verb, mergeDir);
            return new MergeStartResult('conflict', null, mergeDir);
        }
        logBranchMutation(repoRoot, new BranchMutationEvent(verb, 'SQUASH'));

        const nothingStaged = (await this.git.run(['diff-index', '--quiet', '--cached', 'HEAD', '--'])).ok;
        if (nothingStaged) {
            process.stdout.write('ℹ️  Already up-to-date with main (nothing to merge).\n');
        } else {
            // Internal, transient subject for the single squash commit on the feature branch. It NO LONGER
            // reaches main's history: finish-upsert-pr squash-merges the PR with an explicit
            // `gh pr merge --subject <PR title> --body-file <commit summary>`, so main carries the PR title.
            await this.gitExec.runGitChecked(['commit', '-m', `Squash merge of ${currentBranch}`], 'Failed to commit squash merge');
            // Clean merge ⇒ hashes only, no conflicts.md. Its ABSENCE is what marks this merge clean.
            this.mergeState.recordCleanMerge(mergeDir, hashes.hashForkPoint, hashes.hashFeatureHead, hashes.hashMainHead);
        }
        return new MergeStartResult('clean', new MergeContext(currentBranch, squashBranch, backupBranch, prNumber), mergeDir);
    }

    // Detect the PR by its STABLE feature branch (a leftover `…wpN` still resolves to the one name the
    // PR lives on).
    private async detectPr(baseBranch: string): Promise<string> {
        const result = await this.processes.run(
            'gh', ['pr', 'list', '--head', baseBranch, '--json', 'number', '--jq', '.[0].number'],
        );
        return result.ok ? result.stdout.trim() : '';
    }

    // Pick this sync's slot number MONOTONICALLY from the durable audit dirs, then step past any
    // existing `<branch>PreMerge<n>` branch so the same `n` is free for the paired backup branch.
    private async chooseSyncSlot(home: string, currentBranch: string): Promise<SyncSlot> {
        let n = this.mergeState.nextMergeSlotNumber(home);
        while (await this.branchExists(this.branchNaming.preMergeBackupName(currentBranch, n))) n += 1;
        return new SyncSlot(this.branchNaming.preMergeBackupName(currentBranch, n), this.mergeState.mergeRunDirFor(home, n), n);
    }

    // Snapshot the pre-merge state onto the caller-chosen `backupBranch`, never overwriting.
    private async branchExists(name: string): Promise<boolean> {
        return (await this.git.run(['show-ref', '--verify', '--quiet', `refs/heads/${name}`])).ok;
    }

    private async createBackup(currentBranch: string, backupBranch: string): Promise<void> {
        process.stdout.write('\n' + SEP + '💾 Creating Pre-Merge Backup\n' + SEP + '\n');
        await this.gitExec.runGitChecked(['checkout', '-b', backupBranch], 'Failed to create backup branch');
        await this.gitExec.runGitChecked(['checkout', currentBranch], 'Failed to return to feature branch');
        process.stdout.write(`✅ Backup created: ${backupBranch}\n\n`);
    }

    private async saveConflictContext(
        conflictedFiles: string[], mergeDir: string, forkPoint: string, featureHead: string, mainHead: string,
    ): Promise<void> {
        for (const file of conflictedFiles) {
            const fileDir = this.mergeState.perFileContextDir(mergeDir, file);
            fs.mkdirSync(fileDir, { recursive: true });

            const fork = await this.git.run(['show', `${forkPoint}:${file}`]);
            fs.writeFileSync(path.join(fileDir, 'A-forkpoint.txt'), fork.ok ? fork.stdout : '(file did not exist)\n');
            const feature = await this.git.run(['show', `${featureHead}:${file}`]);
            fs.writeFileSync(path.join(fileDir, 'B-feature.txt'), feature.ok ? feature.stdout : '(file did not exist)\n');
            const main = await this.git.run(['show', `${mainHead}:${file}`]);
            fs.writeFileSync(path.join(fileDir, 'C-main.txt'), main.ok ? main.stdout : '(file did not exist)\n');

            const ba = await this.git.run(['diff', forkPoint, featureHead, '--', file]);
            fs.writeFileSync(path.join(fileDir, 'B-A.diff'), ba.stdout);
            const ca = await this.git.run(['diff', forkPoint, mainHead, '--', file]);
            fs.writeFileSync(path.join(fileDir, 'C-A.diff'), ca.stdout);
        }
    }

    // The LIVE rendering of the same template `.webpieces/instruct-ai/webpieces.mergeprocess.md` is
    // delivered from — see rules-config/src/merge-process-doc.ts. The text lives there, not here, so
    // the copy every repo receives and the copy a conflicted merge stamps are the same document.
    private mergeProcessDoc(mergeDir: string, squashBranch: string, conflictedFiles: string[], finishCommand: string): string {
        const fileList = conflictedFiles.map((f: string): string => `- \`${f}\``).join('\n');
        const run = new MergeRun(
            new SyncFlowGuidance().pairedStart(finishCommand), finishCommand, squashBranch, mergeDir, fileList,
        );
        return new MergeProcessText(loadTemplate(MERGE_PROCESS_DOC)).render(run);
    }

    // Returns the absolute path of the written doc.
    private writeMergeProcessDoc(repoRoot: string, mergeDir: string, squashBranch: string, conflictedFiles: string[], finishCommand: string): string {
        const docDir = dotWebpieces.localFile(repoRoot, 'instruct-ai');
        fs.mkdirSync(docDir, { recursive: true });
        const docPath = path.join(docDir, MERGE_PROCESS_DOC);
        fs.writeFileSync(docPath, this.mergeProcessDoc(mergeDir, squashBranch, conflictedFiles, finishCommand));
        return docPath;
    }

    // The AI-facing "what just happened / what to do next" recap on the conflict path.
    private printConflictHandback(
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
        process.stdout.write(`      ${mergeDir}/updatemain-<file>/), \`git add\` it, and write that file's merge-explanation.md\n`);
        process.stdout.write(`   3. run  pnpm ${finishCommand}  — it validates, commits, and finalizes (do NOT git commit/push yourself)\n\n`);
        process.stdout.write('Conflicted files:\n');
        for (const file of conflictedFiles) process.stdout.write(`  - ${file}\n`);
        process.stdout.write('\n' + SEP);
    }

    // Write the conflict context files + the unvalidated marker + the process doc. Does NOT exit.
    private async handleConflictsHandback(
        repoRoot: string, mergeDir: string, currentBranch: string, squashBranch: string,
        backupBranch: string, prNumber: string, hashes: HashPoints, finishCommand: string,
    ): Promise<void> {
        const raw = await this.gitExec.gitQuery(['diff', '--name-only', '--diff-filter=U'], process.cwd(), 'Failed to list conflicted files (git diff --diff-filter=U).');
        const conflictedFiles = raw.split('\n').filter((f: string): boolean => f.trim() !== '');
        fs.mkdirSync(mergeDir, { recursive: true });
        // `conflicts.md` replaces the old `updatemain-conflicted-files.txt` (which nothing read) AND is
        // the 3-point signal itself: this file exists in a run dir if and only if that merge conflicted,
        // which is what lets the index classify each merge without a per-branch directory-name scheme.
        this.mergeState.writeConflicts(mergeDir, conflictedFiles);
        fs.writeFileSync(path.join(mergeDir, 'updatemain-hashes.json'), JSON.stringify(hashes, null, 2) + '\n');
        await this.saveConflictContext(conflictedFiles, mergeDir, hashes.hashForkPoint, hashes.hashFeatureHead, hashes.hashMainHead);

        const marker = new MergeMarker(
            currentBranch, squashBranch, backupBranch, prNumber, conflictedFiles,
            hashes.hashForkPoint, hashes.hashFeatureHead, hashes.hashMainHead, false,
        );
        this.mergeState.writeMergeMarker(mergeDir, marker);
        const docPath = this.writeMergeProcessDoc(repoRoot, mergeDir, squashBranch, conflictedFiles, finishCommand);
        this.printConflictHandback(docPath, mergeDir, squashBranch, conflictedFiles, finishCommand);
    }

    // Short sha of a ref (best-effort — '' if it can't resolve).
    private async shortSha(ref: string): Promise<string> {
        const result = await this.git.run(['rev-parse', '--short', ref]);
        return result.ok ? result.stdout.trim() : '';
    }

    // FULL sha of a ref (best-effort — '' if it can't resolve). Recorded for the pre-merge tips because
    // those hashes are meant to be used later to restore state, and an abbreviated sha can go ambiguous
    // as the repo grows.
    private async fullSha(ref: string): Promise<string> {
        const result = await this.git.run(['rev-parse', ref]);
        return result.ok ? result.stdout.trim() : '';
    }

    // Log the CONFLICT phase with the conflicted-file list + artifact paths a resolver needs.
    private async logConflict(repoRoot: string, verb: MutationVerb, mergeDir: string): Promise<void> {
        const raw = await this.git.run(['diff', '--name-only', '--diff-filter=U'], repoRoot);
        const files = (raw.ok ? raw.stdout : '').split('\n').map((f: string): string => f.trim()).filter((f: string): boolean => f !== '');
        const event = new BranchMutationEvent(verb, 'CONFLICT');
        event.conflict = true;
        event.conflictFiles = files;
        event.artifacts = [
            path.join(mergeDir, 'updatemain-<file>'),
            dotWebpieces.localFile(repoRoot, 'instruct-ai', MERGE_PROCESS_DOC),
        ];
        logBranchMutation(repoRoot, event);
    }
}
