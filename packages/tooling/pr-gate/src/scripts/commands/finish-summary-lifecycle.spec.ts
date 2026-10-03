import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { AtomicFile } from '@webpieces/tooling-common';
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
import { PublishedPr } from '../workflow/gated-pr-publisher';

const state = vi.hoisted(() => ({ head: 'feature-head', config: {} }));
vi.mock('child_process', () => ({
    execSync: vi.fn(() => 'dean/1114-summary'),
    spawnSync: vi.fn((bin: string, args: string[]) => ({
        status: 0,
        stdout:
            bin === 'gh'
                ? '77\thttps://github.test/o/r/pull/77'
                : args[0] === 'rev-parse'
                  ? state.head
                  : 'base',
        stderr: '',
    })),
}));
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
    rounds = new ReviewRoundStateService(this.reviewJson, this.provenance, new AtomicFile());
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
    publish = vi.fn(() => new PublishedPr('77', false));
    build = vi.fn(async () => {});
    console = {
        withCapture: async (_root: string, _name: string, work: () => Promise<void>) => work(),
        say: vi.fn(),
    };
    branch = { getFeatureName: () => 'feature' };
    rootFinder = { resolveRepoRoot: () => this.root };
    mergeState = { mergeDirFor: () => '', findActiveMergeRunDir: () => null };
    buildGate = { runBuildGate: this.build, resolveBuildCommand: () => 'spec-build' };
    scanner = { scan: () => this.scan };

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
                summary: 'Fixes #1114\n\nPreserve intent when regenerating graphs.',
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
            seam({ assertCleanTree: vi.fn() }),
            seam(this.buildGate),
            seam({ existingLogFor: () => '' }),
            seam(this.mergeState),
            seam({
                merge: () => new MergeOutcome(false, false, 'open', MERGE_RESULT_LEFT_TO_HUMAN),
            }),
            seam({ publish: this.publish }),
            seam({
                computeGateResults: () => [],
                countAddedDisables: () => [],
                renderPrBody: () => 'Fixes #1114',
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
            seam({ render: () => '', linkDirective: () => '' }),
            seam({ write: () => '', remove: vi.fn() }),
            seam({ upsert: vi.fn() }),
            seam({ ensure: vi.fn() }),
            seam(this.console),
            seam({ assertNotHotfix: vi.fn() }),
            this.rounds,
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
