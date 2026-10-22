import { checkoutLayout, specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { AtomicFile } from '@webpieces/tooling-common';
import { AgentPayload, CodexAdapter } from '@webpieces/hook-runtime';
import { ChecklistDefinition, ChecklistInstructionsService, DEFAULT_MAX_CONCURRENT_BUILDS, DiffScope, HomeConfig, HomeConfigService, REVIEWER_AGENTS_PLACEHOLDER, RepoRootFinder, ReviewJsonService, ReviewerAgentPolicy, toChecklist } from '@webpieces/rules-config';
import { ReviewIdentityStamp, ReviewIdentityStampService } from '@webpieces/repo-workflow-core';
import { ReviewBudgetCheckOptions, WriteReviewCommand, WriteReviewOptions } from './write-review-command';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BranchNaming } from '../workflow/branch-naming';
import { ChecklistDetector } from '../workflow/checklist-detector';
import { ChecklistScanOptions, ChecklistScanner } from '../workflow/checklist-scanner';
import { ChecklistScopeHasher } from '../workflow/checklist-scope-hasher';
import { DiffBasisResolver } from '../workflow/diff-basis';
import { PrContextWriter } from '../workflow/pr-context-writer';
import { ReviewStageReceipt, ReviewStageReceiptService } from '../workflow/review-stage-receipt';
import { ReviewerIdentityResolver } from '../workflow/reviewer-identity';
import { ReviewerVerdictGate } from '../workflow/reviewer-verdict-gate';
import { HARNESS_TERMINAL, STANDING_CURRENT, VerdictProvenanceService } from '../workflow/verdict-provenance';
import { ReviewRoundStateService } from '../workflow/review-round-state';
import { PrGateFeature } from '../../__tests__/feature-harness';
import { ScriptedRepo } from '../../__tests__/scripted-repo';

/** The branch is fixed rather than read from the process cwd, which a spec does not own. */
class FixedBranchName extends AiBranchName {
    constructor() {
        super(new BranchNaming(), null as never);
    }

    override async getFeatureName(): Promise<string> {
        return 'dean-feat';
    }
}

const reviewJson = new ReviewJsonService();
const stamps = new ReviewIdentityStampService();
const provenance = new VerdictProvenanceService(reviewJson, new AtomicFile());
const receipts = new ReviewStageReceiptService(reviewJson);
// The program, fresh for every test: the shipped container with its process edges mocked (#1381). The tests
// that SCAN answer its git from a ScriptedRepo; the rest never ask git anything.
let feature: PrGateFeature;
let rounds: ReviewRoundStateService;

beforeEach(async () => {
    feature = await PrGateFeature.create();
    rounds = feature.container.get(ReviewRoundStateService);
});
const RED = JSON.stringify({ id: 'security', status: 'red', agent: 'codex', model: 'gpt-5-codex', output: 'GRANT ALL is too wide' });
const ORANGE = JSON.stringify({ id: 'security', status: 'orange', agent: 'codex', model: 'gpt-5-codex', output: 'narrow GRANT ALL to SELECT' });
const CHECKLISTS: ChecklistDefinition[] = [
    toChecklist({ id: 'security', patterns: ['**/*.sql'], required: true }, new ReviewerAgentPolicy('webpieces-reviewer', REVIEWER_AGENTS_PLACEHOLDER)),
];
const GREEN = JSON.stringify({ id: 'security', status: 'green', agent: 'codex', model: 'gpt-5-codex', output: 'no auth surface touched' });

function scanner(): ChecklistScanner {
    const c = feature.container;
    const home = new HomeConfigService();
    vi.spyOn(home, 'load').mockReturnValue(new HomeConfig(false, false, DEFAULT_MAX_CONCURRENT_BUILDS, false));
    return new ChecklistScanner(
        new FixedBranchName(), c.get(ChecklistDetector), c.get(DiffScope), c.get(DiffBasisResolver),
        c.get(PrContextWriter), reviewJson, home, c.get(ChecklistScopeHasher), provenance, receipts, rounds,
    );
}

/**
 * Stage ② having briefed `security` — the receipt the command reads, and nothing else. The command under
 * test never asks git anything (the feature name is fixed above), so no repository is built.
 */
function briefedDir(maxRounds = 2): string {
    const dir = specTempDirs.make('wp-write-review-');
    const receipt = new ReviewStageReceipt('c0ffee', true, 'pnpm build', '', ['security']);
    receipt.scopeHashes = { security: 'scope-of-security' };
    receipt.round = 1;
    receipt.maxReviewerRounds = maxRounds;
    receipts.write(dir, 'dean-feat', receipt);
    return dir;
}

/**
 * A repo on a feature branch with one in-scope change (a ScriptedRepo: no git runs), briefed from a real
 * scan — for the tests that scan.
 */
async function briefedRepo(maxRounds = 2): Promise<string> {
    const dir = specTempDirs.make('wp-write-review-');
    const repo = ScriptedRepo.init(dir, 'main', feature.git);
    repo.write('README.md', '# base\n');
    repo.commitAll('base');
    repo.checkoutNewBranch('dean/feat');
    repo.write('grant.sql', 'GRANT ALL;\n');
    repo.commitAll('change');
    const scan = await scanner().scan(dir, CHECKLISTS, new ChecklistScanOptions(1, false, ''));
    const receipt = new ReviewStageReceipt(scan.basis.headSha, true, 'pnpm build', '', ['security']);
    receipt.scopeHashes = scan.scopeHashes;
    receipt.round = 1;
    receipt.maxReviewerRounds = maxRounds;
    receipts.write(dir, 'dean-feat', receipt);
    return dir;
}

function command(): WriteReviewCommand {
    return new WriteReviewCommand(
        new RepoRootFinder(), new FixedBranchName(), receipts,
        new ReviewerIdentityResolver(stamps), provenance, reviewJson);
}

// What the PreToolUse hook writes for the Bash call that runs the bin.
function hookStamp(dir: string, aiType: string, agentId: string): void {
    stamps.write(dir, new ReviewIdentityStamp('security', aiType, 'sess-1', agentId, 'default', dir, new Date().toISOString()));
}

describe('wp-write-review — the one way a reviewer submits a verdict (issue #863)', () => {
    it('lets a CODEX SUBAGENT submit, and records who it was, where, and which scope', async () => {
        const dir = await briefedRepo();
        hookStamp(dir, 'codex', 'agent-9');
        await command().run(new WriteReviewOptions('security', GREEN, dir));

        const summaryPath = reviewJson.summaryJsonPath(dir, 'dean-feat');
        const record = provenance.read(summaryPath, 'security', 1);
        expect(record?.harness).toBe('codex');
        expect(record?.agentId).toBe('agent-9');
        expect(record?.scopeHash).toBe(receipts.read(dir, 'dean-feat')?.scopeHashes['security']);
        // …and the gate's own scan counts it: a carried-forward, current verdict.
        const scan = await scanner().scan(dir, CHECKLISTS, new ChecklistScanOptions(1, true, ''));
        expect(scan.standings[0].standing).toBe(STANDING_CURRENT);
        expect(scan.outstanding).toEqual([]);
    });

    it('REFUSES the coordinating agent, and writes nothing', async () => {
        const dir = briefedDir();
        hookStamp(dir, 'codex', '');
        await expect(command().run(new WriteReviewOptions('security', GREEN, dir))).rejects.toThrow(/COORDINATING agent/);
        expect(fs.existsSync(reviewJson.checklistResultPath(reviewJson.summaryJsonPath(dir, 'dean-feat'), 'security', 1))).toBe(false);
    });

    it('refuses a checklist stage ② did not brief — a carried verdict cannot be overwritten', async () => {
        const dir = briefedDir();
        stamps.write(dir, new ReviewIdentityStamp('other', 'codex', 'sess-1', 'agent-9', 'default', dir, new Date().toISOString()));
        await expect(command().run(new WriteReviewOptions('other', GREEN.replace('security', 'other'), dir))).rejects.toThrow(/was not briefed/);
    });

    it('refuses a verdict with a field outside the schema, naming it', async () => {
        const dir = briefedDir();
        hookStamp(dir, 'claude-code', 'agent-3');
        const withOverride = JSON.stringify({ id: 'security', status: 'red', agent: 'claude', model: 'opus', output: 'x', override: 'ok' });
        await expect(command().run(new WriteReviewOptions('security', withOverride, dir))).rejects.toThrow(/"override" is not a verdict field/);
    });
});

describe('ReviewerIdentityResolver — who is calling', () => {
    it('is a HUMAN at a terminal when there is no harness env and no stamp', async () => {
        const dir = briefedDir();
        expect(new ReviewerIdentityResolver(stamps).resolve(dir, 'security', {}).harness).toBe(HARNESS_TERMINAL);
    });

    it('refuses a harness-launched call the hook did not stamp — it cannot say who is calling', async () => {
        const dir = briefedDir();
        expect(() => new ReviewerIdentityResolver(stamps).resolve(dir, 'security', { CODEX_THREAD_ID: 't-1' }))
            .toThrow(/no usable identity stamp/);
    });
});

describe('wp-finish-upsert-pr rejects a hand-written verdict (issue #863)', () => {
    it('refuses the PR, names the file as NOT COUNTED, and says who may submit one', async () => {
        const dir = await briefedRepo();
        const summaryPath = reviewJson.summaryJsonPath(dir, 'dean-feat');
        fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
        // Exactly what the Codex coordinator did on #1093 and #1095: the right shape, at the right path.
        fs.writeFileSync(reviewJson.checklistResultPath(summaryPath, 'security', 1), GREEN);
        const scan = await scanner().scan(dir, CHECKLISTS, new ChecklistScanOptions(1, true, ''));
        const gate = new ReviewerVerdictGate(reviewJson, new ChecklistInstructionsService(reviewJson));
        expect(() => gate.assertEveryReviewerRan(scan)).toThrow(/NOT COUNTED/);
        expect(() => gate.assertEveryReviewerRan(scan)).toThrow(/not submitted through pnpm wp-write-review/);
    });
});

/**
 * Issues #1051 and #1053: the round cap is held by the REVIEWER'S own path, not only by the planner — an
 * author agent spawned a reviewer after the cap was spent, and nothing refused it. Every round's verdict is
 * its own file, and none is ever overwritten.
 */
describe('wp-write-review holds the reviewer-round budget (issues #1051, #1053)', () => {
    const YELLOW = GREEN.replace('"green"', '"yellow"');

    function quietly(fn: () => Promise<void>): Promise<void> {
        const out = vi.spyOn(process.stdout, 'write').mockImplementation((): boolean => true);
        return fn().finally((): void => out.mockRestore());
    }

    function atRound(dir: string, round: number): void {
        const receipt = receipts.read(dir, 'dean-feat') as ReviewStageReceipt;
        receipt.round = round;
        receipts.write(dir, 'dean-feat', receipt);
    }

    it('an IN-cap run proceeds: --check says so (and that it is the FINAL round), and the verdict is recorded', async () => {
        const dir = briefedDir(1);
        const out = vi.spyOn(process.stdout, 'write').mockImplementation((): boolean => true);
        await command().check(new ReviewBudgetCheckOptions('security', dir));
        expect(String(out.mock.calls[0]?.[0])).toContain('may be reviewed: this is review round 1 of at most 1');
        expect(String(out.mock.calls[0]?.[0])).toContain('FINAL round');
        out.mockRestore();
        hookStamp(dir, 'claude-code', 'agent-1');
        await quietly((): Promise<void> => command().run(new WriteReviewOptions('security', GREEN, dir)));
        expect(fs.existsSync(reviewJson.checklistResultPath(reviewJson.summaryJsonPath(dir, 'dean-feat'), 'security', 1))).toBe(true);
    });

    it('a second verdict for the same round is refused — by --check and by the submission — and overwrites nothing', async () => {
        const dir = briefedDir(1);
        hookStamp(dir, 'claude-code', 'agent-1');
        await quietly((): Promise<void> => command().run(new WriteReviewOptions('security', GREEN, dir)));
        const verdictPath = reviewJson.checklistResultPath(reviewJson.summaryJsonPath(dir, 'dean-feat'), 'security', 1);
        const before = fs.readFileSync(verdictPath, 'utf8');

        const refusal = 'I am not allowed to review security: it already has a verdict for review round 1';
        await expect(command().check(new ReviewBudgetCheckOptions('security', dir))).rejects.toThrow(refusal);
        hookStamp(dir, 'claude-code', 'agent-2');
        await expect(command().run(new WriteReviewOptions('security', YELLOW, dir))).rejects.toThrow(refusal);
        await expect(command().check(new ReviewBudgetCheckOptions('security', dir))).rejects.toThrow(/report this refusal, verbatim/);
        await expect(command().check(new ReviewBudgetCheckOptions('security', dir))).rejects.not.toThrow(/end (your|the) turn/i);
        expect(fs.readFileSync(verdictPath, 'utf8')).toBe(before);
    });

    it('refuses a round above maxReviewerRounds and records nothing', async () => {
        const dir = briefedDir(1);
        atRound(dir, 2);
        hookStamp(dir, 'claude-code', 'agent-1');
        await expect(command().run(new WriteReviewOptions('security', GREEN, dir)))
            .rejects.toThrow('this briefing is for review round 2, above maxReviewerRounds (1)');
        expect(reviewJson.latestVerdictRound(reviewJson.summaryJsonPath(dir, 'dean-feat'), 'security')).toBe(0);
    });

    it('round 2 of 2 records a NEW file beside round 1 — every round is kept', async () => {
        const dir = briefedDir(2);
        hookStamp(dir, 'claude-code', 'agent-1');
        await quietly((): Promise<void> => command().run(new WriteReviewOptions('security', RED, dir)));
        atRound(dir, 2);
        hookStamp(dir, 'claude-code', 'agent-2');
        await quietly((): Promise<void> => command().run(new WriteReviewOptions('security', YELLOW, dir)));
        const summaryPath = reviewJson.summaryJsonPath(dir, 'dean-feat');
        expect(JSON.parse(fs.readFileSync(reviewJson.checklistResultPath(summaryPath, 'security', 1), 'utf8')).status).toBe('red');
        expect(JSON.parse(fs.readFileSync(reviewJson.checklistResultPath(summaryPath, 'security', 2), 'utf8')).status).toBe('yellow');
        expect(provenance.read(summaryPath, 'security', 2)?.round).toBe(2);
        expect(rounds.highestRound(summaryPath)).toBe(2);
    });
});

/** Issue #1053, section 1: the LAST allowed round has no red — it has orange. */
describe('wp-write-review fits the color to the round (issue #1053)', () => {
    function quietly(fn: () => Promise<void>): Promise<void> {
        const out = vi.spyOn(process.stdout, 'write').mockImplementation((): boolean => true);
        return fn().finally((): void => out.mockRestore());
    }

    it('with maxReviewerRounds: 1, refuses RED and names ORANGE — and records nothing', async () => {
        const dir = briefedDir(1);
        hookStamp(dir, 'claude-code', 'agent-1');
        await expect(command().run(new WriteReviewOptions('security', RED, dir))).rejects.toThrow(/"status": "red" is not allowed: review round 1 of 1 is the FINAL round/);
        hookStamp(dir, 'claude-code', 'agent-1');
        await expect(command().run(new WriteReviewOptions('security', RED, dir))).rejects.toThrow(/Mark anything that must be fixed "orange"/);
        expect(reviewJson.latestVerdictRound(reviewJson.summaryJsonPath(dir, 'dean-feat'), 'security')).toBe(0);
    });

    it('with maxReviewerRounds: 1, accepts ORANGE', async () => {
        const dir = briefedDir(1);
        hookStamp(dir, 'claude-code', 'agent-1');
        await quietly((): Promise<void> => command().run(new WriteReviewOptions('security', ORANGE, dir)));
        const verdictPath = reviewJson.checklistResultPath(reviewJson.summaryJsonPath(dir, 'dean-feat'), 'security', 1);
        expect(JSON.parse(fs.readFileSync(verdictPath, 'utf8')).status).toBe('orange');
    });

    it('before the final round, refuses ORANGE and names RED — a re-review is still paid for', async () => {
        const dir = briefedDir(2);
        hookStamp(dir, 'claude-code', 'agent-1');
        await expect(command().run(new WriteReviewOptions('security', ORANGE, dir))).rejects.toThrow(/"status": "orange" is only for the FINAL review round/);
        hookStamp(dir, 'claude-code', 'agent-1');
        await quietly((): Promise<void> => command().run(new WriteReviewOptions('security', RED, dir)));
        const verdictPath = reviewJson.checklistResultPath(reviewJson.summaryJsonPath(dir, 'dean-feat'), 'security', 1);
        expect(JSON.parse(fs.readFileSync(verdictPath, 'utf8')).status).toBe('red');
    });
});

/** The one export of agent-workflow-rules' stamper this spec drives, typed at the computed import. */
interface StamperModule {
    ReviewIdentityStamper: new () => { stamp(event: ReturnType<CodexAdapter['toEvent']>, command: string, cwd: string): void };
}

// Cross-package integration: the hook producer and the CLI writer must select the SAME namespace.
describe('linked-worktree hook-to-writer routing (#1105)', () => {
    async function worktrees(): Promise<string[]> {
        const primary = await briefedRepo();
        const parent = specTempDirs.makeReal('wp-stamp-trees-');
        const first = path.join(parent, 'first');
        const second = path.join(parent, 'second');
        // What `git worktree add -b review-first|review-second` lays out on disk — all the routing reads.
        checkoutLayout.linkedWorktree(primary, first, 'review-first');
        checkoutLayout.linkedWorktree(primary, second, 'review-second');
        for (const tree of [first, second]) {
            receipts.write(tree, 'dean-feat', receipts.read(primary, 'dean-feat')!);
        }
        return [primary, first, second];
    }

    async function submitHook(primary: string, target: string, agentId = 'reviewer-1105'): Promise<void> {
        const bash = `cd '${target}' && pnpm wp-write-review --checklist security`;
        // The hook producer, run IN PROCESS (#1381) through a COMPUTED import path: a static test import here
        // would falsely add agent-workflow-rules to pr-gate's package dependency graph.
        const producer = path.resolve(__dirname, '../../../../agent-workflow-rules/src/adapters/review-identity-stamper.ts');
        const payload = JSON.stringify({
            tool_name: 'Bash', tool_input: { command: bash }, cwd: primary,
            turn_id: 'fixture-turn', session_id: 'fixture-session', agent_id: agentId, agent_type: 'default',
        });
        const stamperModule = (await import(producer)) as StamperModule;
        const parsed = JSON.parse(payload) as AgentPayload;
        const event = new CodexAdapter().toEvent(parsed, primary);
        new stamperModule.ReviewIdentityStamper().stamp(event, bash, primary);
    }

    it('writes a legitimate verdict in the target worktree and consumes the hook stamp once', async () => {
        const [primary, target, other] = await worktrees();
        await submitHook(primary, target);
        expect(fs.existsSync(stamps.stampPath(primary, 'security'))).toBe(false);
        expect(stamps.take(other, 'security')).toBeNull();
        expect(stamps.take(target, 'other-checklist')).toBeNull();
        const stampPath = stamps.stampPath(target, 'security');
        expect(stampPath).toContain(
            `/.webpieces/worktrees/${path.basename(target)}/review-stamps/`,
        );
        const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
        expect(stamp.cwd).toBe(target);
        expect(stamp.sessionId).toBe('fixture-session');
        await command().run(new WriteReviewOptions('security', GREEN, target));
        const record = provenance.read(
            reviewJson.summaryJsonPath(target, 'dean-feat'),
            'security',
            1,
        );
        expect(record?.agentId).toBe('reviewer-1105');
        expect(record?.harness).toBe('codex');
        expect(stamps.take(target, 'security')).toBeNull();
        expect(
            provenance.read(reviewJson.summaryJsonPath(other, 'dean-feat'), 'security', 1),
        ).toBeNull();
    });

    it('still refuses a coordinator routed into a worktree', async () => {
        const [primary, target] = await worktrees();
        await submitHook(primary, target, '');
        await expect(command().run(new WriteReviewOptions('security', GREEN, target))).rejects.toThrow(
            /COORDINATING agent/,
        );
        expect(stamps.take(target, 'security')).toBeNull();
    });

    it('reports the expected namespace when an old hook stamped the session tree', async () => {
        const [primary, target] = await worktrees();
        hookStamp(primary, 'codex', 'reviewer-1105');
        const resolve = (): void => {
            new ReviewerIdentityResolver(stamps).resolve(target, 'security', {
                CODEX_THREAD_ID: 'fixture-session',
            });
        };
        expect(resolve).toThrow(stamps.stampPath(target, 'security'));
        expect(resolve).toThrow('Submission cwd: ' + target);
        expect(resolve).toThrow('leading cd');
        expect(resolve).not.toThrow('hooks are not installed');
        expect(stamps.take(primary, 'security')?.agentId).toBe('reviewer-1105');
    });
});
