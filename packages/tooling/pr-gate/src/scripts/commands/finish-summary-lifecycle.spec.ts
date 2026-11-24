import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { MockGitProcessApi, MockNativeProcessApi, specTempDirs } from '@webpieces/tooling-testkit';
import { AtomicFile, GitResultDto } from '@webpieces/tooling-common';
import {
    PrGateConfig,
    RequiredChecklist,
    ReviewerAgentPolicy,
    ReviewJsonService,
    GateTokenService,
} from '@webpieces/rules-config';
import { FinishUpsertPrCommand } from './finish-upsert-pr-command';
import { ReviewUpsertPrCommand } from './review-upsert-pr-command';
import { ChecklistScan } from '../workflow/checklist-scanner';
import { ReviewStageReceipt, ReviewStageReceiptService } from '../workflow/review-stage-receipt';
import { ReviewRoundStateService } from '../workflow/review-round-state';
import {
    SubmittedVerdict,
    VerdictProvenance,
    VerdictProvenanceService,
} from '../workflow/verdict-provenance';
import { DiffBasis } from '../workflow/diff-basis';
import { MergeOutcome, MERGE_RESULT_LEFT_TO_HUMAN } from '../workflow/pr-merger';
import { PrBodyDraft, PublishedPr } from '../workflow/gated-pr-publisher';
import { FinishBanner } from '../workflow/finish-banner';

const state = vi.hoisted(() => ({ head: 'feature-head', config: {} }));

// The outside world, SCRIPTED (#1381): git answers HEAD from `state.head` and 'base' for the rest; gh
// answers the PR ref. No process is started.
function scriptedGit(): MockGitProcessApi {
    const git = new MockGitProcessApi();
    git.respondToPrefix(['rev-parse'], (): GitResultDto => git.ok(`${state.head}\n`));
    git.respondToPrefix(['merge-base'], git.ok('base\n'));
    git.respondToPrefix(['diff'], git.ok('base\n'));
    return git;
}

function scriptedGh(): MockNativeProcessApi {
    const gh = new MockNativeProcessApi();
    gh.respondToPrefix('gh', ['pr', 'view'], gh.ok('77\thttps://github.test/o/r/pull/77\n'));
    gh.respondToPrefix('gh', ['pr', 'edit'], gh.ok());
    return gh;
}
vi.mock('@webpieces/rules-config', async (original) => ({
    ...(await original<typeof import('@webpieces/rules-config')>()),
    loadAndValidate: () => ({ prGate: state.config }),
    writeTemplate: vi.fn(),
}));

// Constructor collaborators have broad production surfaces; only their external seams are faked here.
function seam<T>(value: object): T {
    return value as T;
}

class Fixture {
    root = specTempDirs.make('finish-summary-');
    reviewJson = new ReviewJsonService();
    file = this.reviewJson.summaryJsonPath(this.root, 'feature');
    receipts = new ReviewStageReceiptService(this.reviewJson);
    provenance = new VerdictProvenanceService(this.reviewJson, new AtomicFile());
    git = scriptedGit();
    gh = scriptedGh();
    rounds = new ReviewRoundStateService(this.reviewJson, this.provenance, new AtomicFile(), this.git);
    required = new RequiredChecklist('ticket', new ReviewerAgentPolicy('reviewer', 1), '', []);
    scan = seam<ChecklistScan>({
        applicable: [this.required],
        reviewed: [this.required],
        defined: [],
        optionalNotRun: [],
        orangeFixes: {},
        suppressed: [],
        notBriefed: [],
        formatErrors: [],
        standings: [],
        results: [],
        summaryPath: this.file,
        reviewersDisabled: false,
        basis: new DiffBasis('base', state.head, false, [], '', ''),
        changedFiles: [],
    });
    publish = vi.fn((_base: string, _title: string, draft: PrBodyDraft) => new PublishedPr('77', false, draft.body, ''));
    reportPredictedLink = vi.fn();
    build = vi.fn(async () => {});
    console = {
        withCapture: async (_root: string, _name: string, work: () => Promise<void>) => work(),
        say: vi.fn(),
    };
    branch = { getFeatureName: async () => 'feature' };
    rootFinder = { resolveRepoRoot: () => this.root };
    mergeState = { mergeDirFor: () => '', findActiveMergeRunDir: () => null };
    buildGate = { runBuildGate: this.build, resolveBuildCommand: () => 'spec-build' };
    scanner = { scan: () => this.scan };
    // Stubbed by default; the ticket-reminder specs swap in the real banner to assert on what is printed.
    banner: object = { render: () => '', linkDirective: () => '' };

    said(): string {
        return this.console.say.mock.calls.map((call: unknown[]): string => String(call[0])).join('');
    }

    setup(): void {
        state.head = 'feature-head';
        const config = new PrGateConfig();
        config.maxReviewerRounds = 1;
        config.mergeMode = 'NONE';
        config.gateSalt = 'spec-salt';
        state.config = config;
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(
            this.file,
            JSON.stringify({
                agent: 'codex',
                model: 'spec',
                title: 'Preserve PR intent',
                summary: 'Preserve intent when regenerating graphs.',
                addressesIssues: [{ url: 'https://github.com/deanhiller/webpieces-ts/issues/1114', closesIssue: true }],
                riskScore: 10,
                riskLevel: 'green',
            }),
        );
        const receipt = new ReviewStageReceipt(state.head, true, 'spec-build', 'now', ['ticket']);
        receipt.round = 1;
        receipt.maxReviewerRounds = 1;
        this.receipts.write(this.root, 'feature', receipt);
        const record = new VerdictProvenance(
            'ticket',
            'terminal',
            '',
            '',
            'reviewer',
            state.head,
            'scope',
        );
        record.round = 1;
        this.provenance.write(
            this.file,
            new SubmittedVerdict('ticket', 'green', 'reviewer', 'spec', 'Fixes #1114'),
            record,
        );
    }

    finish(): FinishUpsertPrCommand {
        return new FinishUpsertPrCommand(
            seam(this.rootFinder),
            seam(this.branch),
            seam({ baseBranchName: () => 'dean/1114-summary' }),
            seam({ assertCleanTree: vi.fn(), currentBranch: async () => 'dean/1114-summary' }),
            seam(this.buildGate),
            seam({ existingLogFor: () => '' }),
            seam(this.mergeState),
            seam({
                merge: () => new MergeOutcome(false, false, 'open', MERGE_RESULT_LEFT_TO_HUMAN),
            }),
            seam({ publish: this.publish, reportPredictedLink: this.reportPredictedLink }),
            seam({
                computeGateResults: () => [],
                countAddedDisables: () => [],
                renderPrBody: (_input: unknown, prUrl: string) => `Fixes #1114\n${prUrl}`,
                renderDetailComment: () => 'detail',
            }),
            seam({ resolve: () => null }),
            seam({}),
            seam(this.scanner),
            seam({ assertEveryReviewerRan: vi.fn() }),
            this.reviewJson,
            new GateTokenService(),
            seam({ enforce: () => ({ evidence: [] }), archiveRecord: vi.fn() }),
            this.receipts,
            seam(this.banner),
            seam({ write: () => '', remove: vi.fn() }),
            seam({ upsert: vi.fn() }),
            seam({ ensure: vi.fn() }),
            seam(this.console),
            seam({ assertNotHotfix: vi.fn() }),
            this.rounds,
            this.git,
            this.gh,
        );
    }

    review(): ReviewUpsertPrCommand {
        return new ReviewUpsertPrCommand(
            seam(this.rootFinder),
            seam(this.branch),
            seam({ assertCleanTree: vi.fn() }),
            seam(this.buildGate),
            seam({ assertBuildLeftNothingUncommitted: vi.fn() }),
            seam(this.mergeState),
            seam({}),
            seam(this.scanner),
            seam({ render: () => 'same-PR metadata unchanged; finish' }),
            seam({}),
            seam({}),
            seam({}),
            seam({}),
            this.receipts,
            seam({ scan: () => [], render: () => '' }),
            this.reviewJson,
            seam(this.console),
            seam({ assertNotHotfix: vi.fn() }),
            this.rounds,
        );
    }
}

describe('finish → same-PR update → review → finish (#1114)', () => {
    it('publishes twice without rewriting unchanged metadata or rebriefing carried verdicts', async () => {
        const f = new Fixture();
        f.setup();
        const original = fs.readFileSync(f.file, 'utf8');
        const verdict = f.reviewJson.checklistResultPath(f.file, 'ticket', 1);
        const originalVerdict = fs.readFileSync(verdict, 'utf8');
        await f.finish().run();
        expect(fs.readFileSync(f.file, 'utf8')).toBe(original);
        const audits = path.join(path.dirname(f.file), 'published-summaries');
        const first = fs.readdirSync(audits)[0];
        const firstAudit = fs.readFileSync(path.join(audits, first), 'utf8');

        // Start's main update/conflict resolution has completed; the new HEAD needs build evidence.
        state.head = 'regenerated-head';
        f.scan.basis = new DiffBasis('advanced-main', state.head, false, [], '', '');
        await f.review().run();
        expect(f.receipts.read(f.root, 'feature')?.buildHeadSha).toBe(state.head);
        await f.finish().run();
        expect(f.publish).toHaveBeenCalledTimes(2);
        expect(f.build).toHaveBeenCalledTimes(1);
        expect(fs.readFileSync(f.file, 'utf8')).toBe(original);
        expect(fs.readFileSync(verdict, 'utf8')).toBe(originalVerdict);
        expect(fs.readdirSync(audits)).toHaveLength(2);
        expect(fs.readFileSync(path.join(audits, first), 'utf8')).toBe(firstAudit);
    });
});

/**
 * The CREATE path with the PR-number prediction (#1418). The publisher predicted `predicted` and created
 * the PR with that self-link in its body ('' = the prediction failed, so the body went up without one);
 * GitHub then really assigned `real`. Only a body that differs from the final, real-URL render is re-sent.
 */
describe('create path — the predicted self-link (#1418)', () => {
    const urlOf = (n: string): string => `https://github.test/o/r/pull/${n}`;

    async function createPr(f: Fixture, predicted: string, real: string): Promise<string[]> {
        const edits: string[] = [];
        const gh = new MockNativeProcessApi();
        // No PR when finish renders its first body; the one GitHub assigned once the publisher returns.
        gh.respondToPrefix('gh', ['pr', 'view'], gh.fail(1, 'no pull requests found'));
        gh.respondToPrefix('gh', ['pr', 'view'], gh.ok(`${real}\t${urlOf(real)}\n`));
        gh.respondToPrefix('gh', ['pr', 'edit'], (call) => {
            edits.push(fs.readFileSync(call.args[call.args.indexOf('--body-file') + 1], 'utf8'));
            return gh.ok();
        });
        f.gh = gh;
        f.publish.mockImplementation((_base: string, _title: string, draft: PrBodyDraft) =>
            new PublishedPr('', false, predicted === '' ? draft.body : draft.render(urlOf(predicted)), predicted));
        f.setup();
        await f.finish().run();
        return edits;
    }

    it('a correct guess publishes once — no gh pr edit, so creating the PR fires one event', async () => {
        const f = new Fixture();
        expect(await createPr(f, '77', '77')).toEqual([]);
        expect(f.reportPredictedLink).toHaveBeenCalledWith(expect.objectContaining({ predictedNumber: '77' }), '77');
    });

    it('a wrong guess (predicted N, GitHub assigned N+1) back-fills the REAL link with gh pr edit', async () => {
        const f = new Fixture();
        const edits = await createPr(f, '77', '78');
        expect(edits).toHaveLength(1);
        expect(edits[0]).toContain(urlOf('78'));
        expect(edits[0]).not.toContain(urlOf('77'));
        expect(f.reportPredictedLink).toHaveBeenCalledWith(expect.objectContaining({ predictedNumber: '77' }), '78');
    });

    it('a failed prediction falls back to the back-fill, exactly as before #1418', async () => {
        const f = new Fixture();
        const edits = await createPr(f, '', '78');
        expect(edits).toHaveLength(1);
        expect(edits[0]).toContain(urlOf('78'));
    });
});

/**
 * The "update your ticket" next action (#1453): printed after a successful create AND a successful update,
 * carrying the REAL PR URL the command resolved and the summary.json addressesIssues URLs — and absent
 * when no PR exists, so a failed run never reads as a posted one.
 */
describe('ticket-link reminder after the PR is posted (#1453)', () => {
    const ISSUE = 'https://github.com/deanhiller/webpieces-ts/issues/1114';

    function withRealBanner(): Fixture {
        const f = new Fixture();
        f.banner = new FinishBanner();
        return f;
    }

    it('on UPDATE of an existing PR, names the resolved PR URL, the ticket, and keeps earlier PR links', async () => {
        const f = withRealBanner();
        f.setup();
        await f.finish().run();
        const out = f.said();
        expect(out).toContain('UPDATE YOUR TICKET (Linear, Jira, GitHub issue, or another tracker) with a link');
        expect(out).toContain('to this PR: https://github.test/o/r/pull/77');
        expect(out).toContain('Keep the links to earlier PRs');
        expect(out).toContain(`       ${ISSUE}\n`);
        // Never claims the tracker was touched.
        expect(out).toContain('webpieces did NOT update any ticket');
    });

    it('on CREATE, names the URL GitHub actually assigned — never the predicted one', async () => {
        const f = withRealBanner();
        const gh = new MockNativeProcessApi();
        gh.respondToPrefix('gh', ['pr', 'view'], gh.fail(1, 'no pull requests found'));
        gh.respondToPrefix('gh', ['pr', 'view'], gh.ok('78\thttps://github.test/o/r/pull/78\n'));
        gh.respondToPrefix('gh', ['pr', 'edit'], gh.ok());
        f.gh = gh;
        f.publish.mockImplementation((_base: string, _title: string, draft: PrBodyDraft) =>
            new PublishedPr('', false, draft.render('https://github.test/o/r/pull/77'), '77'));
        f.setup();
        await f.finish().run();
        const out = f.said();
        expect(out).toContain('to this PR: https://github.test/o/r/pull/78');
        expect(out).not.toContain('pull/77');
    });

    it('prints NO reminder when gh pr create failed — there is no PR to link', async () => {
        const f = withRealBanner();
        const gh = new MockNativeProcessApi();
        gh.respondToPrefix('gh', ['pr', 'view'], gh.fail(1, 'no pull requests found'));
        f.gh = gh;
        f.publish.mockImplementation((_base: string, _title: string, draft: PrBodyDraft) =>
            new PublishedPr('', true, draft.body, ''));
        f.setup();
        await f.finish().run();
        const out = f.said();
        expect(out).toContain('PR NOT FINISHED');
        expect(out).not.toContain('UPDATE YOUR TICKET');
    });
});
