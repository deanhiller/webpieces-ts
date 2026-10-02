import { describe, it, expect, vi } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AtomicFile } from '@webpieces/tooling-common';
import { toError } from '@webpieces/tooling-common/to-error';
import { CK_ORANGE_FIXED, CK_OVERRIDDEN, ChecklistDefinition, ChecklistInstructionsService, DEFAULT_MAX_CONCURRENT_BUILDS, DiffScope, HomeConfig, HomeConfigService, REVIEWER_AGENTS_PLACEHOLDER, RepoRootFinder, RequiredChecklist, ReviewJsonService, ReviewerAgentPolicy, specTempDirs, toChecklist } from '@webpieces/rules-config';
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
    STANDING_CARRIED, SubmittedVerdict, VerdictProvenance, VerdictProvenanceService, VerdictStanding,
} from './verdict-provenance';
import { WriteReviewFixesCommand, WriteReviewFixesOptions } from '../commands/write-review-fixes-command';

/**
 * Issue #1053 end to end: `maxReviewerRounds` is a HARD ceiling ("1 round means 1 round"), the final round
 * has no red — it has ORANGE, fixed once and never re-reviewed — the checklist set is frozen at the
 * briefing, and staleness never demands a review. Each spec replays a branch against the real scan, round
 * planner, fix recorder and finish gate, with verdicts written as `wp-write-review` writes them.
 */

const FEATURE = 'dean-feat';

class FixedBranchName extends AiBranchName {
    getFeatureName(): string {
        return FEATURE;
    }
}

const reviewJson = new ReviewJsonService();
const provenance = new VerdictProvenanceService(reviewJson, new AtomicFile());
const receipts = new ReviewStageReceiptService(reviewJson);
const rounds = new ReviewRoundStateService(reviewJson, provenance, new AtomicFile());
const gate = new ReviewerVerdictGate(reviewJson, new ChecklistInstructionsService(reviewJson));
const POLICY = new ReviewerAgentPolicy('webpieces-reviewer', REVIEWER_AGENTS_PLACEHOLDER);

// One always-on checklist (no patterns: the WHOLE diff is its scope), one scoped to TypeScript, and one that
// only a later commit touching an .env file ever triggers — the #1355 shape.
const ISSUE = 'issue-requirements-reviewer';
const ERRORS = 'error-handling-reviewer';
const SECRETS = 'config-secrets-reviewer';
const CHECKLISTS: ChecklistDefinition[] = [
    toChecklist({ id: ISSUE, required: true }, POLICY),
    toChecklist({ id: ERRORS, patterns: ['**/*.ts'], required: true }, POLICY),
    toChecklist({ id: SECRETS, patterns: ['**/*.env'], required: true }, POLICY),
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

function repo(): string {
    const dir = specTempDirs.make('wp-orange-');
    git(dir, 'git init -q -b main');
    git(dir, 'git config user.email t@t.co');
    git(dir, 'git config user.name T');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.webpieces/\n');
    commit(dir, 'README.md', '# base\n');
    git(dir, 'git checkout -q -b dean/feat');
    commit(dir, 'store.ts', 'export function load(): string { try { return read(); } catch { return ""; } }\n');
    return dir;
}

/** Stage ② briefing `ids` for `round` of `maxRounds` at the current HEAD — the receipt it writes. */
function brief(dir: string, round: number, maxRounds: number, ids: string[]): ReviewStageReceipt {
    const scan = scanner().scan(dir, CHECKLISTS, new ChecklistScanOptions(maxRounds, false, ''));
    const receipt = new ReviewStageReceipt(scan.basis.headSha, true, 'pnpm build', 'now', ids);
    receipt.scopeHashes = scan.scopeHashes;
    receipt.round = round;
    receipt.maxReviewerRounds = maxRounds;
    receipts.write(dir, FEATURE, receipt);
    return receipt;
}

/** A reviewer subagent's verdict, written exactly where and how `wp-write-review` writes it. */
function submit(dir: string, receipt: ReviewStageReceipt, id: string, status: string, output: string): void {
    const record = new VerdictProvenance(id, 'claude-code', 'sess-1', `agent-${id}-${receipt.round}`, 'webpieces-reviewer',
        receipt.headSha, receipt.scopeHashes[id] ?? '');
    record.round = receipt.round;
    provenance.write(summaryPath(dir), new SubmittedVerdict(id, status, 'claude', 'opus', output), record);
}

/** The author fixes `ids` and records it through the real `pnpm wp-write-review-fixes` command. */
async function fixAndRecord(dir: string, ids: string[], body: string): Promise<void> {
    commit(dir, 'store.ts', body);
    await record(dir, ids);
}

/** `pnpm wp-write-review-fixes` alone, over whatever HEAD is now. */
async function record(dir: string, ids: string[]): Promise<void> {
    const json = JSON.stringify({
        agent: 'claude', model: 'opus',
        responses: ids.map((id: string): Record<string, unknown> => ({ checklistId: id, resolution: `fixed ${id}: corrupt JSON now throws`, files: ['store.ts'] })),
    });
    const cmd = new WriteReviewFixesCommand(new RepoRootFinder(), new FixedBranchName(new BranchNaming()), receipts, rounds);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((): boolean => true);
    // webpieces-disable no-unmanaged-exceptions -- restore stdout whatever the command does; the caller asserts on the outcome
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        await cmd.run(new WriteReviewFixesOptions(json, dir));
    } finally {
        out.mockRestore();
    }
}

/** The scan exactly as `wp-finish-upsert-pr` hands it to its gate. */
function finishScan(dir: string, maxRounds: number): ChecklistScan {
    return scanner().scan(dir, CHECKLISTS, new ChecklistScanOptions(maxRounds, true, ''));
}

function planOf(dir: string, maxRounds: number): string {
    const scan = finishScan(dir, maxRounds);
    return rounds.plan(dir, scan.summaryPath, receipts.read(dir, FEATURE), maxRounds, scan.basis).action;
}

function ids(list: readonly RequiredChecklist[]): string[] {
    return list.map((r: RequiredChecklist): string => r.id);
}

function standingOf(scan: ChecklistScan, id: string): VerdictStanding | undefined {
    return scan.standings.find((s: VerdictStanding): boolean => s.checklistId === id);
}

// The finish gate's refusal, or '' when it lets the PR through.
function refusal(scan: ChecklistScan): string {
    // webpieces-disable no-unmanaged-exceptions -- the refusal text IS the assertion subject
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        gate.assertEveryReviewerRan(scan);
        return '';
    } catch (err: unknown) {
        const error = toError(err);
        return error.message;
    }
}

describe('maxReviewerRounds: 1 — round 1 is the final round, and it ends orange → fix → finish', () => {
    it('refuses the orange once, then passes after the fix is recorded — with no second reviewer spawn', async () => {
        const dir = repo();
        const receipt = brief(dir, 1, 1, [ISSUE, ERRORS]);
        submit(dir, receipt, ISSUE, 'yellow', 'ticket asks for a doc note too');
        submit(dir, receipt, ERRORS, 'orange', 'the catch-all treats a corrupt JSON file as absent');

        const before = refusal(finishScan(dir, 1));
        expect(before).toContain('1 ORANGE');
        expect(before).toContain('pnpm wp-write-review-fixes');
        expect(before).not.toContain('You MUST run these');
        expect(planOf(dir, 1)).toBe(ROUND_ACTION_FINISH);

        await fixAndRecord(dir, [ERRORS], 'export function load(): string { return read(); }\n');

        const after = finishScan(dir, 1);
        expect(after.outstanding).toEqual([]);
        expect(refusal(after)).toBe('');
        const verdict = reviewJson.resolveVerdict(new RequiredChecklist(ERRORS, POLICY, '', []), after.results);
        expect(verdict.status).toBe(CK_ORANGE_FIXED);
        expect(verdict.detail).toMatch(/^orange at [0-9a-f]{8}, author-fixed in [0-9a-f]{8}, not re-reviewed: fixed error-handling-reviewer/);
        expect(after.orangeFixes[ERRORS]).toBe(verdict.detail);
        // …and stage ② agrees: no further round, ever.
        expect(planOf(dir, 1)).toBe(ROUND_ACTION_FINISH);
    });

    it('the recorded fix keeps holding after later commits — staleness never re-opens the review', async () => {
        const dir = repo();
        const receipt = brief(dir, 1, 1, [ISSUE, ERRORS]);
        submit(dir, receipt, ISSUE, 'green', 'ok');
        submit(dir, receipt, ERRORS, 'orange', 'throw on corrupt JSON');
        await fixAndRecord(dir, [ERRORS], 'export function load(): string { return read(); }\n');
        commit(dir, 'store.ts', 'export function load(): string { return read().trim(); }\n');
        commit(dir, 'NOTES.md', 'follow-up\n');

        const scan = finishScan(dir, 1);
        expect(standingOf(scan, ISSUE)?.standing).toBe(STANDING_CARRIED);
        expect(scan.outstanding).toEqual([]);
        expect(refusal(scan)).toBe('');
        expect(planOf(dir, 1)).toBe(ROUND_ACTION_FINISH);
    });

    it('never overwrites a record that still holds: a second wp-write-review-fixes is refused', async () => {
        const dir = repo();
        const receipt = brief(dir, 1, 1, [ERRORS]);
        submit(dir, receipt, ERRORS, 'orange', 'throw on corrupt JSON');
        await fixAndRecord(dir, [ERRORS], 'export function load(): string { return read(); }\n');
        await expect(fixAndRecord(dir, [ERRORS], 'export function load(): string { return read() ?? ""; }\n'))
            .rejects.toThrow(/already recorded .* still holds/);
    });

    // The shape every PR update takes: wp-start-upsert-pr rebuilds the branch as ONE squash commit off main,
    // so the recorded fix commit leaves HEAD's history. Re-recording must be the way past it, never a loop.
    it('after a squash-update, the stale record stops counting, re-recording is accepted, and the old one is kept', async () => {
        const dir = repo();
        const receipt = brief(dir, 1, 1, [ISSUE, ERRORS]);
        submit(dir, receipt, ISSUE, 'green', 'ok');
        submit(dir, receipt, ERRORS, 'orange', 'throw on corrupt JSON');
        await fixAndRecord(dir, [ERRORS], 'export function load(): string { return read(); }\n');
        git(dir, 'git reset -q --soft main');
        git(dir, 'git commit -qm "Squash merge of dean/feat"');

        expect(refusal(finishScan(dir, 1))).toContain('1 ORANGE');
        await record(dir, [ERRORS]);
        expect(refusal(finishScan(dir, 1))).toBe('');
        const fixes = rounds.fixesPath(summaryPath(dir), 1);
        expect(fs.existsSync(`${fixes}.superseded-1`)).toBe(true);
        expect(rounds.highestRound(summaryPath(dir))).toBe(1);
        expect(planOf(dir, 1)).toBe(ROUND_ACTION_FINISH);
    });
});

describe('maxReviewerRounds: 2 — round 1 red → fix → round 2 (final) is orange-only', () => {
    it('re-briefs ONLY the red, keeps round 1 on disk, and the final orange ships once its fix is recorded', async () => {
        const dir = repo();
        const round1 = brief(dir, 1, 2, [ISSUE, ERRORS]);
        submit(dir, round1, ISSUE, 'green', 'ok');
        submit(dir, round1, ERRORS, 'red', 'the catch-all hides corrupt JSON');
        await fixAndRecord(dir, [ERRORS], 'export function load(): string { try { return read(); } catch (e) { throw e; } }\n');

        const scan = finishScan(dir, 2);
        const plan = rounds.plan(dir, scan.summaryPath, receipts.read(dir, FEATURE), 2, scan.basis);
        expect(plan.action).toBe(ROUND_ACTION_REVIEW);
        expect(plan.round).toBe(2);
        expect(plan.redChecklistIds).toEqual([ERRORS]);

        const round2 = brief(dir, 2, 2, [ERRORS]);
        submit(dir, round2, ERRORS, 'orange', 'rethrowing loses the file path; wrap it');
        expect(planOf(dir, 2)).toBe(ROUND_ACTION_FINISH);
        expect(refusal(finishScan(dir, 2))).toContain('1 ORANGE');

        await fixAndRecord(dir, [ERRORS], 'export function load(): string { return read(); }\n');
        const done = finishScan(dir, 2);
        expect(refusal(done)).toBe('');
        expect(fs.existsSync(reviewJson.checklistResultPath(summaryPath(dir), ERRORS, 1))).toBe(true);
        expect(fs.existsSync(rounds.fixesPath(summaryPath(dir), 1))).toBe(true);
        expect(fs.existsSync(rounds.fixesPath(summaryPath(dir), 2))).toBe(true);
        expect(planOf(dir, 2)).toBe(ROUND_ACTION_FINISH);
    });

    it('round 1 all green + a later commit → no round 2 is ever demanded (staleness never re-reviews)', () => {
        const dir = repo();
        const receipt = brief(dir, 1, 2, [ISSUE, ERRORS]);
        submit(dir, receipt, ISSUE, 'green', 'ok');
        submit(dir, receipt, ERRORS, 'yellow', 'consider a typed error');
        commit(dir, 'store.ts', 'export function load(): string { return read(); }\n');

        const scan = finishScan(dir, 2);
        expect(standingOf(scan, ERRORS)?.standing).toBe(STANDING_CARRIED);
        expect(scan.outstanding).toEqual([]);
        expect(refusal(scan)).toBe('');
        expect(planOf(dir, 2)).toBe(ROUND_ACTION_FINISH);
    });
});

describe('the checklist set is FROZEN at the briefing', () => {
    it('a checklist first triggered after the briefing is "not reviewed", never owed, and does not block', () => {
        const dir = repo();
        const receipt = brief(dir, 1, 1, [ISSUE, ERRORS]);
        submit(dir, receipt, ISSUE, 'green', 'ok');
        submit(dir, receipt, ERRORS, 'green', 'ok');
        commit(dir, 'deploy.env', 'API_KEY=placeholder\n');

        const scan = finishScan(dir, 1);
        expect(ids(scan.notBriefed)).toEqual([SECRETS]);
        expect(ids(scan.applicable)).not.toContain(SECRETS);
        expect(scan.outstanding).toEqual([]);
        expect(refusal(scan)).toBe('');
        expect(planOf(dir, 1)).toBe(ROUND_ACTION_FINISH);
    });

    it('before any round starts the set is NOT frozen: the scan still matches the diff', () => {
        const dir = repo();
        commit(dir, 'deploy.env', 'API_KEY=placeholder\n');
        const scan = finishScan(dir, 1);
        expect(ids(scan.applicable)).toContain(SECRETS);
        expect(scan.notBriefed).toEqual([]);
    });
});

describe('the round is derived from the files — there is no separate counter to reset', () => {
    it('with the receipt gone, the round, roster and reviewed HEAD come back from the round files', () => {
        const dir = repo();
        const receipt = brief(dir, 1, 1, [ISSUE, ERRORS]);
        submit(dir, receipt, ISSUE, 'green', 'ok');
        submit(dir, receipt, ERRORS, 'orange', 'throw on corrupt JSON');
        fs.rmSync(receipts.receiptPath(dir, FEATURE));

        const snap = rounds.snapshot(summaryPath(dir), null);
        expect(snap.round).toBe(1);
        expect(snap.roster).toEqual([ERRORS, ISSUE].sort());
        expect(snap.headSha).toBe(receipt.headSha);
        expect(snap.complete).toBe(true);
    });
});

/** Issue #1053 section E (shipped in #1052): a human override is honoured even when staleness is judged first. */
describe('an in-session human override wins over staleness (regression)', () => {
    it('a STALE red whose checklist carries a human override counts', () => {
        const dir = repo();
        const receipt = brief(dir, 1, 2, [ISSUE, ERRORS]);
        submit(dir, receipt, ISSUE, 'green', 'ok');
        submit(dir, receipt, ERRORS, 'red', 'the catch-all hides corrupt JSON');
        commit(dir, 'store.ts', 'export function load(): string { return read(); }\n');
        fs.writeFileSync(path.join(path.dirname(summaryPath(dir)), `override-${ERRORS}.json`), JSON.stringify({
            checklistId: ERRORS, authorizedBy: 'human, in-session', authorizedAt: '2026-09-27T12:00:00Z',
            reason: 'Dean: ship it, tracked in a follow-up',
        }));

        const scan = finishScan(dir, 2);
        expect(standingOf(scan, ERRORS)?.standing).toBe(STANDING_CARRIED);
        expect(standingOf(scan, ERRORS)?.reason).toContain('human override');
        expect(reviewJson.resolveVerdict(new RequiredChecklist(ERRORS, POLICY, '', []), scan.results).status).toBe(CK_OVERRIDDEN);
        expect(ids(scan.outstanding)).not.toContain(ERRORS);
    });
});
