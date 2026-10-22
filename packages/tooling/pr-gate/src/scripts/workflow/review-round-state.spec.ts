import { MockGitProcessApi, ProcessCallDto, specTempDirs } from '@webpieces/tooling-testkit';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { AtomicFile, GitResultDto, PROCESS_NOT_STARTED } from '@webpieces/tooling-common';
import { REVIEWER_AGENTS_PLACEHOLDER, RequiredChecklist, ReviewJsonService, ReviewerAgentPolicy } from '@webpieces/rules-config';
import { DiffBasis } from './diff-basis';
import { ReviewRoundStateService, ROUND_ACTION_FINISH, ROUND_ACTION_RECORD, ROUND_ACTION_RESUME, ROUND_ACTION_REVIEW } from './review-round-state';
import { ReviewStageReceipt } from './review-stage-receipt';
import { SubmittedVerdict, VerdictProvenance, VerdictProvenanceService } from './verdict-provenance';

/**
 * The repository the service asks git about, as a commit GRAPH rather than a directory of objects
 * (#1381). The service asks exactly four things — is the tree clean, what is HEAD, which files differ
 * between two commits, and is a commit in HEAD's history — and each is answered from this model, so the
 * history rewrites these flows depend on (a squash update dropping the reviewed commit) are one line each.
 */
class CommitGraph {
    private readonly parents = new Map<string, string | null>();
    private next = 1;
    head = '';
    untracked = false;

    constructor() {
        this.head = this.commit(null);
    }

    /** A new commit on top of HEAD (every commit in these flows edits a.ts). */
    commitOnHead(): string {
        this.head = this.commit(this.head);
        return this.head;
    }

    /** `git reset --hard HEAD~1`. */
    dropHead(): void {
        this.head = this.parentOf(this.head);
    }

    parentOf(sha: string): string {
        const parent = this.parents.get(sha);
        if (parent === null || parent === undefined) throw new Error(`${sha} has no parent`);
        return parent;
    }

    isAncestorOfHead(sha: string): boolean {
        for (let at: string | null = this.head; at !== null; at = this.parents.get(at) ?? null) {
            if (at === sha) return true;
        }
        return false;
    }

    private commit(parent: string | null): string {
        const sha = String(this.next++).padStart(40, '0');
        this.parents.set(sha, parent);
        return sha;
    }
}

/** git, answered from `graph` for `dir`; a cwd that does not exist could not even start git. */
function scriptedGit(dir: string, graph: CommitGraph): MockGitProcessApi {
    const git = new MockGitProcessApi();
    git.respondToPrefix([], (call: ProcessCallDto): GitResultDto => {
        if (call.cwd !== dir) return git.fail(PROCESS_NOT_STARTED, `spawn git ENOENT (cwd ${call.cwd ?? ''})`);
        const [verb, a, b, c] = call.args;
        if (verb === 'status') return git.ok(graph.untracked ? '?? untracked.txt\n' : '');
        if (verb === 'rev-parse') return git.ok(`${graph.head}\n`);
        if (verb === 'diff') return git.ok(b === c ? '' : 'a.ts\n');
        if (verb === 'merge-base' && a === '--is-ancestor') {
            return graph.isAncestorOfHead(b) ? git.ok() : git.fail(1);
        }
        throw new Error(`unexpected git ${call.args.join(' ')}`);
    });
    return git;
}

const reviewJson = new ReviewJsonService();
const provenance = new VerdictProvenanceService(reviewJson, new AtomicFile());
const graphs = new Map<string, CommitGraph>();
let rounds = new ReviewRoundStateService(reviewJson, provenance, new AtomicFile(), new MockGitProcessApi());

function graphOf(dir: string): CommitGraph {
    const graph = graphs.get(dir);
    if (graph === undefined) throw new Error(`no repository at ${dir}`);
    return graph;
}

/** A repository with one commit; the service under test now asks THIS repository's git. */
function repo(): string {
    const dir = specTempDirs.make('review-rounds-');
    const graph = new CommitGraph();
    graphs.set(dir, graph);
    rounds = new ReviewRoundStateService(reviewJson, provenance, new AtomicFile(), scriptedGit(dir, graph));
    return dir;
}

function head(dir: string): string {
    return graphOf(dir).head;
}

function receiptAt(dir: string, round = 1): ReviewStageReceipt {
    const receipt = new ReviewStageReceipt(head(dir), true, 'pnpm build', 'now', ['security']);
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
    const graph = graphOf(dir);
    const tip = graph.head;
    return new DiffBasis(graph.parentOf(tip), tip, false, [], `git diff HEAD~1 ${tip}`, `git diff HEAD~1 ${tip} -- <file>`);
}

// Every fix edits a.ts; `value` names the edit for the reader.
function commitFix(dir: string, value: number): void {
    void value;
    graphOf(dir).commitOnHead();
}

function remediationJson(checklistIds: string[] = ['security']): string {
    const responses = checklistIds.map((checklistId: string): object => ({ checklistId, resolution: 'restricted the grant', files: ['a.ts'] }));
    return JSON.stringify({ agent: 'codex', model: 'gpt', responses });
}

/** A round-1 receipt briefing `security` (required) plus the given OPTIONAL checklists (issue #1062). */
function receiptWithOptionals(dir: string, required: string[], optional: string[]): ReviewStageReceipt {
    const receipt = new ReviewStageReceipt(head(dir), true, 'pnpm build', 'now', [...required, ...optional]);
    receipt.optionalBriefed = optional.slice();
    receipt.round = 1;
    receipt.maxReviewerRounds = 2;
    return receipt;
}

describe('ReviewRoundStateService', () => {
    it.each([1, 2])(
        'retains published summary through a same-PR main update with carried verdicts (cap %i)',
        async (cap: number) => {
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
                summary: 'Keep PR intent across updates.',
                addressesIssues: [{ url: 'https://github.com/deanhiller/webpieces-ts/issues/1114', closesIssue: true }],
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
            graphOf(dir).dropHead();
            commitFix(dir, 3);
            commitFix(dir, 4);
            expect((await rounds.plan(dir, file, receipt, cap, basis(dir))).action).toBe(
                ROUND_ACTION_FINISH,
            );
            receipt.buildHeadSha = head(dir);

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

    it('resumes an active fixed roster without consuming another round', async () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptAt(dir);
        const plan = await rounds.plan(dir, summary(dir), receipt, 2, basis(dir));
        expect(plan.action).toBe(ROUND_ACTION_RESUME);
        expect(plan.round).toBe(1);
    });

    it.each([1, 2])(
        'resumes a partially completed roster through repeated squash/main updates with cap %i',
        async (cap: number) => {
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
                graphOf(dir).dropHead();
                commitFix(dir, value);
                const plan = await rounds.plan(dir, summary(dir), receipt, cap, basis(dir));
                expect(plan.action).toBe(ROUND_ACTION_RESUME);
                expect(plan.round).toBe(1);
                expect(rounds.snapshot(summary(dir), receipt).roster).toEqual(
                    receipt.reviewersBriefed,
                );
                expect(provenance.read(summary(dir), 'security', 1)).toEqual(original);
            }
            archive(dir, receipt, 'green', 'pending');
            expect((await rounds.plan(dir, summary(dir), receipt, cap, basis(dir))).action).toBe(
                ROUND_ACTION_FINISH,
            );
            expect(rounds.highestRound(summary(dir))).toBe(1);
        },
    );

    it.each([1, 2])(
        'resumes an entirely pending roster across HEAD movement with cap %i',
        async (cap: number) => {
            const dir = repo();
            commitFix(dir, 2);
            const receipt = receiptAt(dir);
            receipt.maxReviewerRounds = cap;
            for (const value of [3, 4]) {
                commitFix(dir, value);
                expect((await rounds.plan(dir, summary(dir), receipt, cap, basis(dir))).action).toBe(
                    ROUND_ACTION_RESUME,
                );
                expect((await rounds.plan(dir, summary(dir), receipt, cap, basis(dir))).round).toBe(1);
            }
        },
    );

    it('requires a SHA-bound remediation, then starts one focused round over every fix commit', async () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptAt(dir);
        archive(dir, receipt, 'red');
        commitFix(dir, 3);
        commitFix(dir, 4);
        expect((await rounds.plan(dir, summary(dir), receipt, 2, basis(dir))).action).toBe(ROUND_ACTION_RECORD);
        await rounds.writeRemediation(dir, summary(dir), receipt, remediationJson());
        const plan = await rounds.plan(dir, summary(dir), receipt, 2, basis(dir));
        expect(plan.action).toBe(ROUND_ACTION_REVIEW);
        expect(plan.round).toBe(2);
        expect(plan.basis.base).toBe(receipt.headSha);
        expect(plan.changedFiles).toEqual(['a.ts']);
    });

    it('on the final round an ORANGE is fixed once, stamped "not re-reviewed", and never starts round 3', async () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptAt(dir, 2);
        archive(dir, receipt, 'orange');
        commitFix(dir, 3);
        await rounds.writeRemediation(dir, summary(dir), receipt, remediationJson());
        const plan = await rounds.plan(dir, summary(dir), receipt, 2, basis(dir));
        expect(plan.action).toBe(ROUND_ACTION_FINISH);
        expect(plan.orangeChecklistIds).toEqual(['security']);
        const results = reviewJson.loadChecklistResults(summary(dir), [new RequiredChecklist('security', new ReviewerAgentPolicy('webpieces-reviewer', REVIEWER_AGENTS_PLACEHOLDER), '', [])]);
        expect((await rounds.orangeFixes(dir, summary(dir), results))['security']).toContain('not re-reviewed: restricted the grant');
    });

    it('a green round never opens another, even with rounds left and HEAD moved', async () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptAt(dir, 1);
        archive(dir, receipt, 'green');
        commitFix(dir, 3);
        expect((await rounds.plan(dir, summary(dir), receipt, 2, basis(dir))).action).toBe(ROUND_ACTION_FINISH);
    });

    it('drops a recorded fix whose toHead is no longer in HEAD\'s history', async () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptAt(dir, 1);
        archive(dir, receipt, 'red');
        commitFix(dir, 3);
        await rounds.writeRemediation(dir, summary(dir), receipt, remediationJson());
        graphOf(dir).dropHead();
        commitFix(dir, 9);
        expect((await rounds.plan(dir, summary(dir), receipt, 2, basis(dir))).action).toBe(ROUND_ACTION_RECORD);
    });

    it('refuses dirty remediation state, including untracked files', async () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptAt(dir);
        archive(dir, receipt, 'red');
        commitFix(dir, 3);
        graphOf(dir).untracked = true;
        await expect(rounds.writeRemediation(dir, summary(dir), receipt, remediationJson())).rejects.toThrow(/staged, unstaged, or untracked/);
    });

    it('refuses an existing malformed durable verdict instead of treating it as absent', async () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptAt(dir);
        const verdictPath = reviewJson.checklistResultPath(summary(dir), 'security', receipt.round);
        fs.mkdirSync(path.dirname(verdictPath), { recursive: true });
        fs.writeFileSync(verdictPath, '{ not json');

        const snap = rounds.snapshot(summary(dir), receipt);
        expect((): string[] => rounds.checklistIdsWithStatus(summary(dir), snap, 'red')).toThrow(`Could not read review state file ${verdictPath}`);
    });

    it('refuses a failed Git command instead of treating its output as empty', async () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptAt(dir);
        archive(dir, receipt, 'red');

        await expect(rounds.writeRemediation(path.join(dir, 'missing'), summary(dir), receipt, remediationJson()))
            .rejects.toThrow('Review-round Git command failed: git status --porcelain --untracked-files=all');
    });
});

/**
 * Issue #1062: an OPTIONAL checklist the human did not choose to run must never hold a round open. Before the
 * fix every briefed checklist was on the roster, so a required red plus two unrun optionals left the round
 * "not complete" forever: wp-write-review-fixes refused, and the next commit hit "still active".
 */
describe('optional checklists never block a review round (issue #1062)', () => {
    it('a required red with unrun optionals completes the round, accepts the fix, and re-briefs only the red', async () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptWithOptionals(dir, ['security'], ['docs', 'style']);
        archive(dir, receipt, 'red');
        const snap = rounds.snapshot(summary(dir), receipt);
        expect(snap.complete).toBe(true);
        expect(snap.roster).toEqual(['security']);
        commitFix(dir, 3);
        await rounds.writeRemediation(dir, summary(dir), receipt, remediationJson());
        const plan = await rounds.plan(dir, summary(dir), receipt, 2, basis(dir));
        expect(plan.action).toBe(ROUND_ACTION_REVIEW);
        expect(plan.round).toBe(2);
        expect(plan.redChecklistIds).toEqual(['security']);
    });

    it('an optional checklist that RAN and came back red is on the roster, blocks, and is re-briefed', async () => {
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
        await expect(rounds.writeRemediation(dir, summary(dir), receipt, remediationJson()))
            .rejects.toThrow(/Missing: docs/);
        await rounds.writeRemediation(dir, summary(dir), receipt, remediationJson(['docs']));
        const plan = await rounds.plan(dir, summary(dir), receipt, 2, basis(dir));
        expect(plan.action).toBe(ROUND_ACTION_REVIEW);
        expect(plan.redChecklistIds).toEqual(['docs']);
    });

    it('a round still waits on a REQUIRED checklist that has no verdict, whatever the optionals did', async () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptWithOptionals(dir, ['security'], ['docs']);
        archive(dir, receipt, 'green', 'docs');
        expect(rounds.snapshot(summary(dir), receipt).complete).toBe(false);
        expect((await rounds.plan(dir, summary(dir), receipt, 2, basis(dir))).action).toBe(ROUND_ACTION_RESUME);
    });

    it('an all-optional briefing nobody ran does not deadlock the next commit', async () => {
        const dir = repo();
        commitFix(dir, 2);
        const receipt = receiptWithOptionals(dir, [], ['docs']);
        commitFix(dir, 3);
        const snap = rounds.snapshot(summary(dir), receipt);
        expect(snap.complete).toBe(true);
        expect(snap.roster).toEqual([]);
        expect((await rounds.plan(dir, summary(dir), receipt, 2, basis(dir))).action).toBe(ROUND_ACTION_FINISH);
    });
});
