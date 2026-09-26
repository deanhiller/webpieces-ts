import { describe, it, expect, vi } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    AtomicFile, ChecklistDefinition, ChecklistInstructionsService, DEFAULT_MAX_CONCURRENT_BUILDS, DiffScope, HomeConfig,
    HomeConfigService, REVIEWER_AGENTS_PLACEHOLDER, RepoRootFinder, RequiredChecklist, ReviewJsonService,
    ReviewerAgentPolicy, specTempDirs, toChecklist,
} from '@webpieces/rules-config';
import { AiBranchName } from './git-readAiBranchName';
import { BranchNaming } from './branch-naming';
import { ChecklistDetector } from './checklist-detector';
import { ChecklistScan, ChecklistScanOptions, ChecklistScanner } from './checklist-scanner';
import { ChecklistScopeHasher } from './checklist-scope-hasher';
import { DiffBasisResolver } from './diff-basis';
import { DiffMaterializer } from './diff-materializer';
import { ForkPoint } from './git-findForkPoint';
import { GitStatusParser } from './git-status';
import { PrContextWriter } from './pr-context-writer';
import { ReviewRoundStateService, ROUND_ACTION_FINISH, ROUND_ACTION_REVIEW } from './review-round-state';
import { ReviewStageReceipt, ReviewStageReceiptService } from './review-stage-receipt';
import { ReviewerVerdictGate } from './reviewer-verdict-gate';
import {
    STANDING_CARRIED, STANDING_STALE, SubmittedVerdict, VerdictProvenance, VerdictProvenanceService, VerdictStanding,
} from './verdict-provenance';
import { WriteReviewFixesCommand, WriteReviewFixesOptions } from '../commands/write-review-fixes-command';

/**
 * Issue #1051: with `maxReviewerRounds: 1` the flow is review → fix → submit. The author's remediation
 * commit used to mark every OTHER non-red verdict STALE, the round cap forbade re-reviewing it, and an
 * in-session human override could not clear it because staleness was judged first — a deadlock. These
 * specs replay that branch against the real scan, round planner, remediation writer and finish gate.
 */

const FEATURE = 'dean-feat';

class FixedBranchName extends AiBranchName {
    getFeatureName(): string {
        return FEATURE;
    }
}

/** One reviewed branch: its repo and the receipt stage ② wrote for round 1. Data-only. */
class ReviewedRound {
    dir: string;
    receipt: ReviewStageReceipt;

    constructor(dir: string, receipt: ReviewStageReceipt) {
        this.dir = dir;
        this.receipt = receipt;
    }
}

const reviewJson = new ReviewJsonService();
const provenance = new VerdictProvenanceService(reviewJson, new AtomicFile());
const receipts = new ReviewStageReceiptService(reviewJson);
const rounds = new ReviewRoundStateService(reviewJson, provenance, new AtomicFile());
const gate = new ReviewerVerdictGate(reviewJson, new ChecklistInstructionsService(reviewJson));
const POLICY = new ReviewerAgentPolicy('webpieces-reviewer', REVIEWER_AGENTS_PLACEHOLDER);

// The repro's two checklists: one always-on (no patterns, so its scope is the WHOLE diff) and one scoped.
const ISSUE = 'issue-requirements-reviewer';
const ERRORS = 'error-handling-reviewer';
const CHECKLISTS: ChecklistDefinition[] = [
    toChecklist({ id: ISSUE, required: true }, POLICY),
    toChecklist({ id: ERRORS, patterns: ['**/*.ts'], required: true }, POLICY),
];

function git(cwd: string, cmd: string): string {
    return execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

function scanner(): ChecklistScanner {
    const diffScope = new DiffScope();
    const home = new HomeConfigService();
    vi.spyOn(home, 'load').mockReturnValue(new HomeConfig(false, false, DEFAULT_MAX_CONCURRENT_BUILDS, false));
    return new ChecklistScanner(
        new FixedBranchName(new BranchNaming()), new ChecklistDetector(diffScope), diffScope,
        new DiffBasisResolver(new ForkPoint(null as never, null as never, null as never), new GitStatusParser()),
        new PrContextWriter(diffScope, reviewJson), reviewJson, home,
        new ChecklistScopeHasher(new DiffMaterializer(reviewJson)), provenance, receipts, rounds,
    );
}

function commit(dir: string, file: string, body: string): void {
    fs.writeFileSync(path.join(dir, file), body);
    git(dir, 'git add -A');
    git(dir, `git commit -qm "edit ${file}"`);
}

function summaryPath(dir: string): string {
    return reviewJson.summaryJsonPath(dir, FEATURE);
}

/**
 * Stage ② has run round 1 of `maxRounds` at the current HEAD, and both reviewer subagents have submitted
 * through the bin: issue-requirements YELLOW, error-handling RED — exactly the state the issue reports.
 */
function reviewedRound(maxRounds: number): ReviewedRound {
    const dir = specTempDirs.make('wp-round-cap-');
    git(dir, 'git init -q -b main');
    git(dir, 'git config user.email t@t.co');
    git(dir, 'git config user.name T');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.webpieces/\n');
    commit(dir, 'README.md', '# base\n');
    git(dir, 'git checkout -q -b dean/feat');
    commit(dir, 'store.ts', 'export function load(): string { try { return read(); } catch { return ""; } }\n');

    const scan = scanner().scan(dir, CHECKLISTS, new ChecklistScanOptions(maxRounds, false, ''));
    const receipt = new ReviewStageReceipt(scan.basis.headSha, true, 'pnpm build', 'now', [ISSUE, ERRORS]);
    receipt.scopeHashes = scan.scopeHashes;
    receipt.round = 1;
    receipt.maxReviewerRounds = maxRounds;
    receipts.write(dir, FEATURE, receipt);
    submit(dir, receipt, ISSUE, 'yellow', 'ticket asks for a doc note too');
    submit(dir, receipt, ERRORS, 'red', 'the catch-all treats a corrupt JSON file as absent');
    return new ReviewedRound(dir, receipt);
}

function submit(dir: string, receipt: ReviewStageReceipt, id: string, status: string, output: string): void {
    const record = new VerdictProvenance(id, 'claude-code', 'sess-1', `agent-${id}`, 'webpieces-reviewer',
        receipt.headSha, receipt.scopeHashes[id] ?? '');
    record.round = receipt.round;
    provenance.write(summaryPath(dir), new SubmittedVerdict(id, status, 'claude', 'opus', output), record);
    rounds.archiveVerdict(summaryPath(dir), id, receipt.round);
}

/** The author fixes the red and records it through `pnpm wp-write-review-fixes` — the real command. */
async function remediate(dir: string): Promise<void> {
    commit(dir, 'store.ts', 'export function load(): string { return read(); }\n');
    const json = JSON.stringify({
        agent: 'claude', model: 'opus',
        responses: [{ checklistId: ERRORS, resolution: 'corrupt JSON now throws instead of reading as absent', files: ['store.ts'] }],
    });
    const cmd = new WriteReviewFixesCommand(new RepoRootFinder(), new FixedBranchName(new BranchNaming()), receipts, rounds);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((): boolean => true);
    await cmd.run(new WriteReviewFixesOptions(json, dir));
    out.mockRestore();
}

/**
 * The scan exactly as `wp-finish-upsert-pr` hands it to its gate: author remediations recorded after the
 * cap folded in, and the checklists they cover taken off `outstanding`.
 */
function finishScan(dir: string, maxRounds: number): ChecklistScan {
    const scan = scanner().scan(dir, CHECKLISTS, new ChecklistScanOptions(maxRounds, true, ''));
    const remediations = rounds.capRemediations(dir, scan.summaryPath, receipts.read(dir, FEATURE), maxRounds);
    for (const result of scan.results) result.remediation = remediations[result.id] ?? '';
    scan.outstanding = scan.outstanding.filter((req: RequiredChecklist): boolean => remediations[req.id] === undefined);
    return scan;
}

function standingOf(scan: ChecklistScan, id: string): VerdictStanding | undefined {
    return scan.standings.find((s: VerdictStanding): boolean => s.checklistId === id);
}

function ids(list: readonly RequiredChecklist[]): string[] {
    return list.map((r: RequiredChecklist): string => r.id);
}

function writeOverride(dir: string, id: string, body: string): void {
    fs.writeFileSync(path.join(path.dirname(summaryPath(dir)), `override-${id}.json`), body);
}

describe('maxReviewerRounds: 1 — review → fix → submit (issue #1051)', () => {
    it('DEADLOCK REPRO: after the red is remediated, finish carries the yellow forward instead of calling it STALE', async () => {
        const reviewed = reviewedRound(1);
        await remediate(reviewed.dir);

        const scan = finishScan(reviewed.dir, 1);
        expect(standingOf(scan, ISSUE)?.standing).toBe(STANDING_CARRIED);
        expect(standingOf(scan, ISSUE)?.reason).toContain('CARRIED FORWARD without re-review');
        expect(ids(scan.reviewed)).toContain(ISSUE);
        expect(scan.outstanding).toEqual([]);
        expect((): void => gate.assertEveryReviewerRan(scan)).not.toThrow();
        // …and stage ② agrees: the budget is spent, so it briefs nobody.
        expect(rounds.plan(reviewed.dir, scan.summaryPath, receipts.read(reviewed.dir, FEATURE), 1, scan.basis).action)
            .toBe(ROUND_ACTION_FINISH);
    });

    it('demands NO second round whatever changes afterwards — more commits, summary edits, gate re-runs', async () => {
        const reviewed = reviewedRound(1);
        await remediate(reviewed.dir);
        commit(reviewed.dir, 'NOTES.md', 'ticket follow-up\n');
        commit(reviewed.dir, 'store.ts', 'export function load(): string { return read().trim(); }\n');

        for (let rerun = 0; rerun < 2; rerun++) {
            const scan = finishScan(reviewed.dir, 1);
            expect(standingOf(scan, ISSUE)?.standing).toBe(STANDING_CARRIED);
            // The red's recorded remediation no longer covers HEAD, so it is the ONLY thing still owed —
            // and it is owed a recorded fix, never a reviewer.
            expect(ids(scan.outstanding)).toEqual([ERRORS]);
        }
        // One refusal, naming the fix recorder and never a discounted verdict or a reviewer to spawn.
        expect((): void => gate.assertEveryReviewerRan(finishScan(reviewed.dir, 1)))
            .toThrow(/^(?![\s\S]*(NOT COUNTED|NO VERDICT YET))[\s\S]*wp-write-review-fixes/);
    });

    it('keeps the budget meaningful: with a round still unspent, the same change is STALE and re-briefed', async () => {
        const reviewed = reviewedRound(2);
        await remediate(reviewed.dir);

        const scan = scanner().scan(reviewed.dir, CHECKLISTS, new ChecklistScanOptions(2, true, ''));
        expect(standingOf(scan, ISSUE)?.standing).toBe(STANDING_STALE);
        expect(ids(scan.outstanding)).toContain(ISSUE);
        expect(rounds.plan(reviewed.dir, scan.summaryPath, receipts.read(reviewed.dir, FEATURE), 2, scan.basis).action)
            .toBe(ROUND_ACTION_REVIEW);
    });

    it('never carries a RED: an unremediated red after the cap still refuses', () => {
        const reviewed = reviewedRound(1);
        commit(reviewed.dir, 'store.ts', 'export function load(): string { return read(); }\n');

        const scan = finishScan(reviewed.dir, 1);
        expect(standingOf(scan, ERRORS)?.standing).toBe(STANDING_STALE);
        expect(ids(scan.outstanding)).toEqual([ERRORS]);
        expect((): void => gate.assertEveryReviewerRan(scan)).toThrow(/REFUSED/);
    });
});

describe('an in-session human override wins over staleness (issue #1051)', () => {
    const OVERRIDE = JSON.stringify({
        checklistId: ISSUE, authorizedBy: 'human, in-session', authorizedAt: '2026-09-26T12:00:00Z',
        reason: 'Dean: ship it, the yellow is a doc nit',
    });

    it('counts a STALE yellow whose checklist carries a human override, even with rounds left', async () => {
        const reviewed = reviewedRound(2);
        await remediate(reviewed.dir);
        writeOverride(reviewed.dir, ISSUE, OVERRIDE);

        const scan = scanner().scan(reviewed.dir, CHECKLISTS, new ChecklistScanOptions(2, true, ''));
        expect(standingOf(scan, ISSUE)?.standing).toBe(STANDING_CARRIED);
        expect(standingOf(scan, ISSUE)?.reason).toContain('human override');
        expect(ids(scan.outstanding)).not.toContain(ISSUE);
    });

    it('ignores a MALFORMED override: it authorizes nothing, so the stale verdict is still owed', async () => {
        const reviewed = reviewedRound(2);
        await remediate(reviewed.dir);
        writeOverride(reviewed.dir, ISSUE, '{ not json');

        const scan = scanner().scan(reviewed.dir, CHECKLISTS, new ChecklistScanOptions(2, true, ''));
        expect(standingOf(scan, ISSUE)?.standing).toBe(STANDING_STALE);
        expect(ids(scan.outstanding)).toContain(ISSUE);
    });
});

describe('wp-write-review-fixes stamps remediationFromHead (issue #1051)', () => {
    it('records the reviewed HEAD the accepted remediation starts from, and keeps the receipt mtime', async () => {
        const reviewed = reviewedRound(1);
        const receiptPath = receipts.receiptPath(reviewed.dir, FEATURE);
        const past = new Date('2026-01-01T00:00:00Z');
        fs.utimesSync(receiptPath, past, past);
        expect(receipts.read(reviewed.dir, FEATURE)?.remediationFromHead).toBe('');

        await remediate(reviewed.dir);

        const after = receipts.read(reviewed.dir, FEATURE);
        expect(after?.remediationFromHead).toBe(reviewed.receipt.headSha);
        expect(after?.headSha).toBe(reviewed.receipt.headSha);
        expect(after?.round).toBe(1);
        expect(receipts.writtenAtMs(reviewed.dir, FEATURE)).toBe(past.getTime());
    });
});
