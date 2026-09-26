import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import {
    AtomicFile, REVIEWER_AGENTS_PLACEHOLDER, RequiredChecklist, ReviewJsonService, ReviewerAgentPolicy, specTempDirs,
} from '@webpieces/rules-config';
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

function archive(dir: string, receipt: ReviewStageReceipt, status: string): void {
    const verdict = new SubmittedVerdict('security', status, 'reviewer', 'model', status === 'green' ? 'looks good' : 'fix auth');
    const record = new VerdictProvenance('security', 'terminal', '', '', 'human', receipt.headSha, 'scope');
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

function remediationJson(): string {
    return JSON.stringify({ agent: 'codex', model: 'gpt', responses: [{ checklistId: 'security', resolution: 'restricted the grant', files: ['a.ts'] }] });
}

describe('ReviewRoundStateService', () => {
    it('resumes an active fixed roster without consuming another round', () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptAt(dir);
        const plan = rounds.plan(dir, summary(dir), receipt, 2, basis(dir));
        expect(plan.action).toBe(ROUND_ACTION_RESUME);
        expect(plan.round).toBe(1);
    });

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
