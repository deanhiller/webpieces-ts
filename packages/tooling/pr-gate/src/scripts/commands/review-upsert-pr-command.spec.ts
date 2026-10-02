import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { describe, expect, it, vi } from 'vitest';
import { AtomicFile } from '@webpieces/tooling-common';
import {
    ReviewJsonService,
    ReviewerInstructionsService,
    specTempDirs,
} from '@webpieces/rules-config';
import { ReviewUpsertPrCommand } from './review-upsert-pr-command';
import { DiffBasis } from '../workflow/diff-basis';
import { GateLogFile } from '../workflow/gate-log-file';
import { ReviewStageReceipt, ReviewStageReceiptService } from '../workflow/review-stage-receipt';
import { ReviewRoundStateService } from '../workflow/review-round-state';
import { ReviewReportInput } from '../workflow/review-report';
import { StageOutputLog } from '../workflow/stage-output-log';
import {
    SubmittedVerdict,
    VerdictProvenance,
    VerdictProvenanceService,
} from '../workflow/verdict-provenance';

vi.mock('@webpieces/rules-config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@webpieces/rules-config')>();
    return {
        ...actual,
        writeTemplate: vi.fn(),
        loadAndValidate: vi.fn(() => ({ prGate: { checklists: [], maxReviewerRounds: 2 } })),
    };
});

class RecoveryFixture {
    readonly root = specTempDirs.make('resume-stage-');
    readonly feature = 'dean-1087';
    readonly reviewJson = new ReviewJsonService();
    readonly receipts = new ReviewStageReceiptService(this.reviewJson);
    readonly provenance = new VerdictProvenanceService(this.reviewJson, new AtomicFile());
    readonly rounds = new ReviewRoundStateService(this.reviewJson, this.provenance, new AtomicFile());
    readonly instructions = new ReviewerInstructionsService(this.reviewJson);
    readonly summary = this.reviewJson.summaryJsonPath(this.root, this.feature);
    readonly receipt = new ReviewStageReceipt('historical', true, 'build', 'old', ['accepted', 'pending', 'optional']);
    readonly record = new VerdictProvenance('accepted', 'terminal', '', '', 'human', 'historical', 'accepted-scope');
    readonly instruction = this.instructions.pathFor(this.root, this.feature, 'pending');
    readonly diff = path.join(this.reviewJson.prDirFor(this.root, this.feature), 'diff', 'ALL.diff');
    readonly materialize = vi.fn();
    readonly build = vi.fn(async (): Promise<void> => {});
    readonly output: string[] = [];
    readonly report = vi.fn((_input: ReviewReportInput): string => 'reviewers suppressed');
    reviewersDisabled = false;
    readonly basis = new DiffBasis('new-fork', 'updated-1');

    constructor(cap: number) {
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: this.root });
        this.receipt.round = 1;
        this.receipt.maxReviewerRounds = cap;
        this.receipt.optionalBriefed = ['optional'];
        this.receipt.scopeHashes = { accepted: 'accepted-scope', pending: 'pending-scope', optional: 'optional-scope' };
        this.receipts.write(this.root, this.feature, this.receipt);
        this.record.round = 1;
        this.provenance.write(this.summary, new SubmittedVerdict('accepted', 'green', 'reviewer', 'model', 'accepted'), this.record);
        fs.mkdirSync(path.dirname(this.instruction), { recursive: true });
        fs.writeFileSync(this.instruction, 'original briefing');
        fs.mkdirSync(path.dirname(this.diff), { recursive: true });
        fs.writeFileSync(this.diff, 'original diff');
    }

    command(): ReviewUpsertPrCommand {
        const stage = new StageOutputLog(new GateLogFile());
        vi.spyOn(stage, 'say').mockImplementation((text: string): void => { this.output.push(text); });
        const scan = { summaryPath: this.summary, basis: this.basis, scopeHashes: { pending: 'current-scope' },
            reviewersDisabled: this.reviewersDisabled, defined: [], applicable: [], reviewed: [], formatErrors: [],
            suppressed: [], notBriefed: [], standings: [], results: [] };
        return new ReviewUpsertPrCommand(
            { resolveRepoRoot: (): string => this.root } as never,
            { getFeatureName: (): string => this.feature } as never,
            { assertCleanTree: vi.fn() } as never,
            { runBuildGate: this.build, resolveBuildCommand: (): string => 'build-current' } as never,
            { assertBuildLeftNothingUncommitted: vi.fn() } as never,
            { mergeDirFor: (): string => '', findActiveMergeRunDir: (): null => null } as never,
            null as never, { scan: (): typeof scan => scan } as never, { render: this.report } as never,
            { materialize: this.materialize } as never, null as never, null as never,
            this.instructions, this.receipts, { scan: (): never[] => [], render: (): string => '' } as never, this.reviewJson, stage,
            { assertNotHotfix: vi.fn() } as never, this.rounds,
        );
    }
}

describe('stage ② recovery of an incomplete fixed roster (issue #1087)', () => {
    it.each([1, 2])('preserves the roster and history through repeated updates with cap %i', async (cap: number) => {
        const f = new RecoveryFixture(cap);
        const command = f.command();
        for (const head of ['updated-1', 'updated-2', 'updated-3']) {
            f.basis.headSha = head;
            await command.run();
            const saved = f.receipts.read(f.root, f.feature);
            expect(saved?.buildHeadSha).toBe(head);
            expect(saved?.buildCommand).toBe('build-current');
            expect(saved?.buildPassedAt).not.toBe('old');
            expect(saved?.headSha).toBe('historical');
            expect(saved?.reviewersBriefed).toEqual(f.receipt.reviewersBriefed);
            expect(saved?.scopeHashes).toEqual(f.receipt.scopeHashes);
            expect(saved?.round).toBe(1);
            expect(saved?.maxReviewerRounds).toBe(cap);
            expect(f.provenance.read(f.summary, 'accepted', 1)).toEqual(f.record);
            expect(fs.readFileSync(f.instruction, 'utf8')).toBe('original briefing');
            expect(fs.readFileSync(f.diff, 'utf8')).toBe('original diff');
        }
        expect(f.build).toHaveBeenCalledTimes(3);
        expect(f.materialize).not.toHaveBeenCalled();
        expect(f.output.join('')).toContain(`REQUIRED pending: ${f.instruction}`);
        expect(f.output.join('')).not.toContain('REQUIRED accepted');
        expect(f.output.join('')).not.toContain('REQUIRED optional');
        expect(f.output.join('')).toContain("pnpm wp-write-review --checklist pending --file '<verdict JSON file>'");
        expect(f.output.join('')).toContain('pnpm wp-finish-upsert-pr');
    });
    it('honors reviewer suppression during recovery while retaining the pending roster and current build', async () => {
        const f = new RecoveryFixture(2);
        f.reviewersDisabled = true;
        f.basis.headSha = 'updated';
        await f.command().run();
        expect(f.report).toHaveBeenCalledOnce();
        expect(f.report.mock.calls[0][0].reviewersSuppressed).toBe(true);
        expect(f.output.join('')).toContain('reviewers suppressed');
        expect(f.output.join('')).not.toContain('REQUIRED pending');
        expect(f.receipts.read(f.root, f.feature)?.reviewersBriefed).toEqual(f.receipt.reviewersBriefed);
        expect(f.receipts.read(f.root, f.feature)?.headSha).toBe('historical');
        expect(f.receipts.read(f.root, f.feature)?.buildHeadSha).toBe('updated');
        expect(fs.readFileSync(f.diff, 'utf8')).toBe('original diff');
    });

});
