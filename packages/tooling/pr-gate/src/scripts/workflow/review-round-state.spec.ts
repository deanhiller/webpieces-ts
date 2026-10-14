import { specTempDirs } from '@webpieces/tooling-testkit';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { AtomicFile } from '@webpieces/tooling-common';
import { REVIEWER_AGENTS_PLACEHOLDER, RequiredChecklist, ReviewJsonService, ReviewerAgentPolicy } from '@webpieces/rules-config';
import { DiffBasis } from './diff-basis';
import { ReviewRoundStateService, ROUND_ACTION_FINISH, ROUND_ACTION_RECORD, ROUND_ACTION_RESUME, ROUND_ACTION_REVIEW } from './review-round-state';
import { ReviewStageReceipt } from './review-stage-receipt';
import { SubmittedVerdict, VerdictProvenance, VerdictProvenanceService } from './verdict-provenance';

const reviewJson = new ReviewJsonService();
const provenance = new VerdictProvenanceService(reviewJson, new AtomicFile());
const rounds = new ReviewRoundStateService(reviewJson, provenance, new AtomicFile());

function git(dir: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function repo(): string {
    const dir = specTempDirs.make('review-rounds-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'spec@example.com');
    git(dir, 'config', 'user.name', 'Spec');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.webpieces/\n');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
    git(dir, 'add', '.gitignore', 'a.ts');
    git(dir, 'commit', '-qm', 'base');
    return dir;
}

function receiptAt(dir: string, round = 1): ReviewStageReceipt {
    const receipt = new ReviewStageReceipt(git(dir, 'rev-parse', 'HEAD'), true, 'pnpm build', 'now', ['security']);
    receipt.round = round;
    receipt.maxReviewerRounds = 2;
    receipt.scopeHashes = { security: 'scope' };
    return receipt;
}

function summary(dir: string): string {
    return reviewJson.summaryJsonPath(dir, 'feature');
}

function archive(dir: string, receipt: ReviewStageReceipt, status: string, checklistId = 'security'): void {
    const verdict = new SubmittedVerdict(checklistId, status, 'reviewer', 'model', status === 'green' ? 'looks good' : 'fix auth');
    const record = new VerdictProvenance(checklistId, 'terminal', '', '', 'human', receipt.headSha, 'scope');
    record.round = receipt.round;
    provenance.write(summary(dir), verdict, record);
}

function basis(dir: string): DiffBasis {
    const head = git(dir, 'rev-parse', 'HEAD');
    return new DiffBasis(git(dir, 'rev-parse', 'HEAD~1'), head, false, [], `git diff HEAD~1 ${head}`, `git diff HEAD~1 ${head} -- <file>`);
}

function commitFix(dir: string, value: number): void {
    fs.writeFileSync(path.join(dir, 'a.ts'), `export const a = ${value};\n`);
    git(dir, 'add', 'a.ts');
    git(dir, 'commit', '-qm', `fix ${value}`);
}

function remediationJson(checklistIds: string[] = ['security']): string {
    const responses = checklistIds.map((checklistId: string): object => ({ checklistId, resolution: 'restricted the grant', files: ['a.ts'] }));
    return JSON.stringify({ agent: 'codex', model: 'gpt', responses });
}

/** A round-1 receipt briefing `security` (required) plus the given OPTIONAL checklists (issue #1062). */
function receiptWithOptionals(dir: string, required: string[], optional: string[]): ReviewStageReceipt {
    const receipt = new ReviewStageReceipt(git(dir, 'rev-parse', 'HEAD'), true, 'pnpm build', 'now', [...required, ...optional]);
    receipt.optionalBriefed = optional.slice();
    receipt.round = 1;
    receipt.maxReviewerRounds = 2;
    return receipt;
}

describe('ReviewRoundStateService', () => {
    it.each([1, 2])(
        'retains published summary through a same-PR main update with carried verdicts (cap %i)',
        (cap: number) => {
            const dir = repo();
            commitFix(dir, 2);
            const receipt = receiptAt(dir);
            receipt.maxReviewerRounds = cap;
            archive(dir, receipt, 'green');
            const file = summary(dir);
            const body = JSON.stringify({
                agent: 'codex',
                model: 'spec',
                title: 'Fix generated graphs',
                summary: 'Fixes #1114\n\nKeep PR intent across updates.',
                riskScore: 10,
                riskLevel: 'green',
            });
            fs.writeFileSync(file, body);
            const required = [
                new RequiredChecklist('security', new ReviewerAgentPolicy('reviewer', 1), '', []),
            ];
            const originalVerdict = fs.readFileSync(
                reviewJson.checklistResultPath(file, 'security', 1),
                'utf8',
            );
            const firstSummary = reviewJson.loadSummaryJson(file, required);
            const firstSnapshot = reviewJson.snapshotSummaryJson(file);
            const firstAudit = fs.readFileSync(firstSnapshot, 'utf8');

            // The updater squashes onto advancing main; conflict resolution changes generated code only.
            git(dir, 'checkout', '-q', 'main');
            git(dir, 'reset', '--hard', 'HEAD~1');
            commitFix(dir, 3);
            git(dir, 'checkout', '-q', '-b', 'updated-feature');
            commitFix(dir, 4);
            expect(rounds.plan(dir, file, receipt, cap, basis(dir)).action).toBe(
                ROUND_ACTION_FINISH,
            );
            receipt.buildHeadSha = git(dir, 'rev-parse', 'HEAD');

            // Finish loads the unchanged active intent and carried verdict, then snapshots publication again.
            expect(reviewJson.loadSummaryJson(file, required)).toEqual(firstSummary);
            const secondSnapshot = reviewJson.snapshotSummaryJson(file);
            expect(secondSnapshot).not.toBe(firstSnapshot);
            expect(fs.readFileSync(firstSnapshot, 'utf8')).toBe(firstAudit);
            expect(fs.readFileSync(file, 'utf8')).toBe(body);
            expect(
                fs.readFileSync(reviewJson.checklistResultPath(file, 'security', 1), 'utf8'),
            ).toBe(originalVerdict);
        },
    );

    it('resumes an active fixed roster without consuming another round', () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptAt(dir);
        const plan = rounds.plan(dir, summary(dir), receipt, 2, basis(dir));
        expect(plan.action).toBe(ROUND_ACTION_RESUME);
        expect(plan.round).toBe(1);
    });

    it.each([1, 2])(
        'resumes a partially completed roster through repeated squash/main updates with cap %i',
        (cap: number) => {
            const dir = repo();
            commitFix(dir, 2);
            const receipt = receiptAt(dir);
            receipt.maxReviewerRounds = cap;
            receipt.reviewersBriefed = ['security', 'errors', 'pending'];
            archive(dir, receipt, 'green', 'security');
            archive(dir, receipt, 'yellow', 'errors');
            const original = provenance.read(summary(dir), 'security', 1);
            for (const value of [3, 4, 5]) {
                // The sanctioned updater rewrites commits and moves the fork point, so historical HEAD is
                // deliberately no longer an ancestor. Round accounting must not depend on either hash.
                git(dir, 'reset', '-q', '--hard', 'HEAD~1');
                commitFix(dir, value);
                const plan = rounds.plan(dir, summary(dir), receipt, cap, basis(dir));
                expect(plan.action).toBe(ROUND_ACTION_RESUME);
                expect(plan.round).toBe(1);
                expect(rounds.snapshot(summary(dir), receipt).roster).toEqual(
                    receipt.reviewersBriefed,
                );
                expect(provenance.read(summary(dir), 'security', 1)).toEqual(original);
            }
            archive(dir, receipt, 'green', 'pending');
            expect(rounds.plan(dir, summary(dir), receipt, cap, basis(dir)).action).toBe(
                ROUND_ACTION_FINISH,
            );
            expect(rounds.highestRound(summary(dir))).toBe(1);
        },
    );

    it.each([1, 2])(
        'resumes an entirely pending roster across HEAD movement with cap %i',
        (cap: number) => {
            const dir = repo();
            commitFix(dir, 2);
            const receipt = receiptAt(dir);
            receipt.maxReviewerRounds = cap;
            for (const value of [3, 4]) {
                commitFix(dir, value);
                expect(rounds.plan(dir, summary(dir), receipt, cap, basis(dir)).action).toBe(
                    ROUND_ACTION_RESUME,
                );
                expect(rounds.plan(dir, summary(dir), receipt, cap, basis(dir)).round).toBe(1);
            }
        },
    );

    it('requires a SHA-bound remediation, then starts one focused round over every fix commit', () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptAt(dir);
        archive(dir, receipt, 'red');
        commitFix(dir, 3);
        commitFix(dir, 4);
        expect(rounds.plan(dir, summary(dir), receipt, 2, basis(dir)).action).toBe(ROUND_ACTION_RECORD);
        rounds.writeRemediation(dir, summary(dir), receipt, remediationJson());
        const plan = rounds.plan(dir, summary(dir), receipt, 2, basis(dir));
        expect(plan.action).toBe(ROUND_ACTION_REVIEW);
        expect(plan.round).toBe(2);
        expect(plan.basis.base).toBe(receipt.headSha);
        expect(plan.changedFiles).toEqual(['a.ts']);
    });

    it('on the final round an ORANGE is fixed once, stamped "not re-reviewed", and never starts round 3', () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptAt(dir, 2);
        archive(dir, receipt, 'orange');
        commitFix(dir, 3);
        rounds.writeRemediation(dir, summary(dir), receipt, remediationJson());
        const plan = rounds.plan(dir, summary(dir), receipt, 2, basis(dir));
        expect(plan.action).toBe(ROUND_ACTION_FINISH);
        expect(plan.orangeChecklistIds).toEqual(['security']);
        const results = reviewJson.loadChecklistResults(summary(dir), [new RequiredChecklist('security', new ReviewerAgentPolicy('webpieces-reviewer', REVIEWER_AGENTS_PLACEHOLDER), '', [])]);
        expect(rounds.orangeFixes(dir, summary(dir), results)['security']).toContain('not re-reviewed: restricted the grant');
    });

    it('a green round never opens another, even with rounds left and HEAD moved', () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptAt(dir, 1);
        archive(dir, receipt, 'green');
        commitFix(dir, 3);
        expect(rounds.plan(dir, summary(dir), receipt, 2, basis(dir)).action).toBe(ROUND_ACTION_FINISH);
    });

    it('drops a recorded fix whose toHead is no longer in HEAD\'s history', () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptAt(dir, 1);
        archive(dir, receipt, 'red');
        commitFix(dir, 3);
        rounds.writeRemediation(dir, summary(dir), receipt, remediationJson());
        git(dir, 'reset', '-q', '--hard', 'HEAD~1');
        commitFix(dir, 9);
        expect(rounds.plan(dir, summary(dir), receipt, 2, basis(dir)).action).toBe(ROUND_ACTION_RECORD);
    });

    it('refuses dirty remediation state, including untracked files', () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptAt(dir);
        archive(dir, receipt, 'red');
        commitFix(dir, 3);
        fs.writeFileSync(path.join(dir, 'untracked.txt'), 'dirty\n');
        expect((): string => rounds.writeRemediation(dir, summary(dir), receipt, remediationJson())).toThrow(/staged, unstaged, or untracked/);
    });

    it('refuses an existing malformed durable verdict instead of treating it as absent', () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptAt(dir);
        const verdictPath = reviewJson.checklistResultPath(summary(dir), 'security', receipt.round);
        fs.mkdirSync(path.dirname(verdictPath), { recursive: true });
        fs.writeFileSync(verdictPath, '{ not json');

        const snap = rounds.snapshot(summary(dir), receipt);
        expect((): string[] => rounds.checklistIdsWithStatus(summary(dir), snap, 'red')).toThrow(`Could not read review state file ${verdictPath}`);
    });

    it('refuses a failed Git command instead of treating its output as empty', () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptAt(dir);
        archive(dir, receipt, 'red');

        expect((): string => rounds.writeRemediation(path.join(dir, 'missing'), summary(dir), receipt, remediationJson()))
            .toThrow('Review-round Git command failed: git status --porcelain --untracked-files=all');
    });
});

/**
 * Issue #1062: an OPTIONAL checklist the human did not choose to run must never hold a round open. Before the
 * fix every briefed checklist was on the roster, so a required red plus two unrun optionals left the round
 * "not complete" forever: wp-write-review-fixes refused, and the next commit hit "still active".
 */
describe('optional checklists never block a review round (issue #1062)', () => {
    it('a required red with unrun optionals completes the round, accepts the fix, and re-briefs only the red', () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptWithOptionals(dir, ['security'], ['docs', 'style']);
        archive(dir, receipt, 'red');
        const snap = rounds.snapshot(summary(dir), receipt);
        expect(snap.complete).toBe(true);
        expect(snap.roster).toEqual(['security']);
        commitFix(dir, 3);
        rounds.writeRemediation(dir, summary(dir), receipt, remediationJson());
        const plan = rounds.plan(dir, summary(dir), receipt, 2, basis(dir));
        expect(plan.action).toBe(ROUND_ACTION_REVIEW);
        expect(plan.round).toBe(2);
        expect(plan.redChecklistIds).toEqual(['security']);
    });

    it('an optional checklist that RAN and came back red is on the roster, blocks, and is re-briefed', () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptWithOptionals(dir, ['security'], ['docs', 'style']);
        archive(dir, receipt, 'green');
        archive(dir, receipt, 'red', 'docs');
        const snap = rounds.snapshot(summary(dir), receipt);
        expect(snap.complete).toBe(true);
        expect(snap.roster).toEqual(['security', 'docs']);
        expect(rounds.checklistIdsWithStatus(summary(dir), snap, 'red')).toEqual(['docs']);
        commitFix(dir, 3);
        expect((): string => rounds.writeRemediation(dir, summary(dir), receipt, remediationJson()))
            .toThrow(/Missing: docs/);
        rounds.writeRemediation(dir, summary(dir), receipt, remediationJson(['docs']));
        const plan = rounds.plan(dir, summary(dir), receipt, 2, basis(dir));
        expect(plan.action).toBe(ROUND_ACTION_REVIEW);
        expect(plan.redChecklistIds).toEqual(['docs']);
    });

    it('a round still waits on a REQUIRED checklist that has no verdict, whatever the optionals did', () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptWithOptionals(dir, ['security'], ['docs']);
        archive(dir, receipt, 'green', 'docs');
        expect(rounds.snapshot(summary(dir), receipt).complete).toBe(false);
        expect(rounds.plan(dir, summary(dir), receipt, 2, basis(dir)).action).toBe(ROUND_ACTION_RESUME);
    });

    it('an all-optional briefing nobody ran does not deadlock the next commit', () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptWithOptionals(dir, [], ['docs']);
        commitFix(dir, 3);
        const snap = rounds.snapshot(summary(dir), receipt);
        expect(snap.complete).toBe(true);
        expect(snap.roster).toEqual([]);
        expect(rounds.plan(dir, summary(dir), receipt, 2, basis(dir)).action).toBe(ROUND_ACTION_FINISH);
    });
});
