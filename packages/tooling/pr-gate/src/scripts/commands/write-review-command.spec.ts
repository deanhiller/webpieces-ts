import { describe, it, expect, vi } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    AtomicFile, ChecklistDefinition, ChecklistInstructionsService, DEFAULT_MAX_CONCURRENT_BUILDS, DiffScope, HomeConfig,
    HomeConfigService, REVIEWER_AGENTS_PLACEHOLDER, RepoRootFinder, ReviewIdentityStamp, ReviewIdentityStampService,
    ReviewJsonService, ReviewerAgentPolicy, specTempDirs, toChecklist,
} from '@webpieces/rules-config';
import { WriteReviewCommand, WriteReviewOptions } from './write-review-command';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BranchNaming } from '../workflow/branch-naming';
import { ChecklistDetector } from '../workflow/checklist-detector';
import { ChecklistScanOptions, ChecklistScanner } from '../workflow/checklist-scanner';
import { ChecklistScopeHasher } from '../workflow/checklist-scope-hasher';
import { DiffBasisResolver } from '../workflow/diff-basis';
import { DiffMaterializer } from '../workflow/diff-materializer';
import { ForkPoint } from '../workflow/git-findForkPoint';
import { GitStatusParser } from '../workflow/git-status';
import { PrContextWriter } from '../workflow/pr-context-writer';
import { ReviewStageReceipt, ReviewStageReceiptService } from '../workflow/review-stage-receipt';
import { ReviewerIdentityResolver } from '../workflow/reviewer-identity';
import { ReviewerVerdictGate } from '../workflow/reviewer-verdict-gate';
import { HARNESS_TERMINAL, STANDING_CURRENT, VerdictProvenanceService } from '../workflow/verdict-provenance';

/** The branch is fixed rather than read from the process cwd, which a spec does not own. */
class FixedBranchName extends AiBranchName {
    getFeatureName(): string {
        return 'dean-feat';
    }
}

const reviewJson = new ReviewJsonService();
const stamps = new ReviewIdentityStampService();
const provenance = new VerdictProvenanceService(reviewJson, new AtomicFile());
const receipts = new ReviewStageReceiptService(reviewJson);
const CHECKLISTS: ChecklistDefinition[] = [
    toChecklist({ id: 'security', patterns: ['**/*.sql'], required: true }, new ReviewerAgentPolicy('webpieces-reviewer', REVIEWER_AGENTS_PLACEHOLDER)),
];
const GREEN = JSON.stringify({ id: 'security', status: 'green', agent: 'codex', model: 'gpt-5-codex', output: 'no auth surface touched' });

function git(cwd: string, cmd: string): void {
    execSync(cmd, { cwd, stdio: 'pipe' });
}

function scanner(): ChecklistScanner {
    const diffScope = new DiffScope();
    const home = new HomeConfigService();
    vi.spyOn(home, 'load').mockReturnValue(new HomeConfig(false, false, DEFAULT_MAX_CONCURRENT_BUILDS, false, false));
    return new ChecklistScanner(
        new FixedBranchName(new BranchNaming()), new ChecklistDetector(diffScope), diffScope,
        new DiffBasisResolver(new ForkPoint(null as never, null as never, null as never), new GitStatusParser()),
        new PrContextWriter(diffScope, reviewJson), reviewJson, home,
        new ChecklistScopeHasher(new DiffMaterializer(reviewJson)), provenance,
    );
}

/** A repo on a feature branch with one in-scope change, and stage ② having briefed `security` on it. */
function briefedRepo(): string {
    const dir = specTempDirs.make('wp-write-review-');
    git(dir, 'git init -q -b main');
    git(dir, 'git config user.email t@t.co');
    git(dir, 'git config user.name T');
    fs.writeFileSync(path.join(dir, 'README.md'), '# base\n');
    git(dir, 'git add -A');
    git(dir, 'git commit -qm base');
    git(dir, 'git checkout -q -b dean/feat');
    fs.writeFileSync(path.join(dir, 'grant.sql'), 'GRANT ALL;\n');
    git(dir, 'git add -A');
    git(dir, 'git commit -qm change');
    const scan = scanner().scan(dir, CHECKLISTS, new ChecklistScanOptions(false, ''));
    const receipt = new ReviewStageReceipt(scan.basis.headSha, true, 'pnpm build', '', ['security']);
    receipt.scopeHashes = scan.scopeHashes;
    receipts.write(dir, 'dean-feat', receipt);
    return dir;
}

function command(): WriteReviewCommand {
    return new WriteReviewCommand(
        new RepoRootFinder(), new FixedBranchName(new BranchNaming()), receipts,
        new ReviewerIdentityResolver(stamps), provenance);
}

// What the PreToolUse hook writes for the Bash call that runs the bin.
function hookStamp(dir: string, aiType: string, agentId: string): void {
    stamps.write(dir, new ReviewIdentityStamp('security', aiType, 'sess-1', agentId, 'default', dir, new Date().toISOString()));
}

describe('wp-write-review — the one way a reviewer submits a verdict (issue #863)', () => {
    it('lets a CODEX SUBAGENT submit, and records who it was, where, and which scope', async () => {
        const dir = briefedRepo();
        hookStamp(dir, 'codex', 'agent-9');
        await command().run(new WriteReviewOptions('security', GREEN, dir));

        const summaryPath = reviewJson.summaryJsonPath(dir, 'dean-feat');
        const record = provenance.read(summaryPath, 'security');
        expect(record?.harness).toBe('codex');
        expect(record?.agentId).toBe('agent-9');
        expect(record?.scopeHash).toBe(receipts.read(dir, 'dean-feat')?.scopeHashes['security']);
        // …and the gate's own scan counts it: a carried-forward, current verdict.
        const scan = scanner().scan(dir, CHECKLISTS, new ChecklistScanOptions(true, ''));
        expect(scan.standings[0].standing).toBe(STANDING_CURRENT);
        expect(scan.outstanding).toEqual([]);
    });

    it('REFUSES the coordinating agent, and writes nothing', () => {
        const dir = briefedRepo();
        hookStamp(dir, 'codex', '');
        expect(() => command().run(new WriteReviewOptions('security', GREEN, dir))).toThrow(/COORDINATING agent/);
        expect(fs.existsSync(reviewJson.checklistResultPath(reviewJson.summaryJsonPath(dir, 'dean-feat'), 'security'))).toBe(false);
    });

    it('refuses a checklist stage ② did not brief — a carried verdict cannot be overwritten', () => {
        const dir = briefedRepo();
        stamps.write(dir, new ReviewIdentityStamp('other', 'codex', 'sess-1', 'agent-9', 'default', dir, new Date().toISOString()));
        expect(() => command().run(new WriteReviewOptions('other', GREEN.replace('security', 'other'), dir))).toThrow(/was not briefed/);
    });

    it('refuses a verdict with a field outside the schema, naming it', () => {
        const dir = briefedRepo();
        hookStamp(dir, 'claude-code', 'agent-3');
        const withOverride = JSON.stringify({ id: 'security', status: 'red', agent: 'claude', model: 'opus', output: 'x', override: 'ok' });
        expect(() => command().run(new WriteReviewOptions('security', withOverride, dir))).toThrow(/"override" is not a verdict field/);
    });
});

describe('ReviewerIdentityResolver — who is calling', () => {
    it('is a HUMAN at a terminal when there is no harness env and no stamp', () => {
        const dir = briefedRepo();
        expect(new ReviewerIdentityResolver(stamps).resolve(dir, 'security', {}).harness).toBe(HARNESS_TERMINAL);
    });

    it('refuses a harness-launched call the hook did not stamp — it cannot say who is calling', () => {
        const dir = briefedRepo();
        expect(() => new ReviewerIdentityResolver(stamps).resolve(dir, 'security', { CODEX_THREAD_ID: 't-1' }))
            .toThrow(/left no identity stamp/);
    });
});

describe('wp-finish-upsert-pr rejects a hand-written verdict (issue #863)', () => {
    it('refuses the PR, names the file as NOT COUNTED, and says who may submit one', () => {
        const dir = briefedRepo();
        const summaryPath = reviewJson.summaryJsonPath(dir, 'dean-feat');
        fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
        // Exactly what the Codex coordinator did on #1093 and #1095: the right shape, at the right path.
        fs.writeFileSync(reviewJson.checklistResultPath(summaryPath, 'security'), GREEN);
        const scan = scanner().scan(dir, CHECKLISTS, new ChecklistScanOptions(true, ''));
        const gate = new ReviewerVerdictGate(reviewJson, new ChecklistInstructionsService(reviewJson));
        expect(() => gate.assertEveryReviewerRan(scan)).toThrow(/NOT COUNTED/);
        expect(() => gate.assertEveryReviewerRan(scan)).toThrow(/not submitted through pnpm wp-write-review/);
    });
});
