import { specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { AtomicFile } from '@webpieces/tooling-common';
import { ChecklistDefinition, ChecklistOverride, ChecklistResult, checklistOverrideService, DEFAULT_MAX_CONCURRENT_BUILDS, DiffScope, HomeConfig, HomeConfigService, RepoRootFinder, RequiredChecklist, REVIEWER_AGENTS_PLACEHOLDER, ReviewerAgentPolicy, ReviewJsonService, toChecklist } from '@webpieces/rules-config';
import { ChecklistDetector, TriggeredChecklist } from './checklist-detector';
import { ChecklistScan, ChecklistScanner, ChecklistScanOptions } from './checklist-scanner';
import { ForkPoint } from './git-findForkPoint';
import { DiffBasisResolver } from './diff-basis';
import { PrContextWriter } from './pr-context-writer';
import { AiBranchName } from './git-readAiBranchName';
import { PrGateFeature } from '../../__tests__/feature-harness';
import { ScriptedRepo } from '../../__tests__/scripted-repo';
import { ChecklistScopeHasher } from './checklist-scope-hasher';
import { ReviewStageReceipt, ReviewStageReceiptService } from './review-stage-receipt';
import { ReviewRoundStateService } from './review-round-state';
import {
    STANDING_CARRIED, STANDING_CURRENT, STANDING_REJECTED, SubmittedVerdict, VerdictProvenance, VerdictProvenanceService, VerdictStanding,
} from './verdict-provenance';

// The program under test: the SHIPPED container with its process edges mocked (#1381), and the one scratch
// repository its scripted git answers from. Fresh for every test.
let feature: PrGateFeature;
let repo: ScriptedRepo;

beforeEach(async () => {
    feature = await PrGateFeature.create();
});

/**
 * A repo with `main` at a baseline commit and a feature branch checked out — modelled by {@link ScriptedRepo}
 * over a real scratch directory, so every git question the pipeline asks is answered as git would answer
 * it without starting git. These tests are about which git plumbing gets invoked; the argv the mock
 * records is that plumbing.
 */
function repoOnBranch(): string {
    const dir = specTempDirs.make('wp-scan-');
    repo = ScriptedRepo.init(dir, 'main', feature.git);
    repo.write('README.md', '# base\n');
    repo.commitAll('base');
    repo.checkoutNewBranch('feature');
    return dir;
}

/** A repo whose only branch is `other`: neither origin/main nor main resolves. */
function repoWithoutMain(prefix: string, file: string): string {
    const dir = specTempDirs.make(prefix);
    repo = ScriptedRepo.init(dir, 'other', feature.git);
    repo.write(file, file.endsWith('.sql') ? 'x\n' : 'a\n');
    repo.commitAll('a');
    return dir;
}

/** One raw config entry as a fixture. `required` is omitted by most tests — see {@link defs}. */
const REVIEWER = new ReviewerAgentPolicy('webpieces-reviewer', REVIEWER_AGENTS_PLACEHOLDER);

interface RawItem { id?: string; doc?: string; patterns?: string[]; required?: boolean }

/**
 * The already-validated `prGate.checklists` a command would hand the scanner. Built through the real
 * `toChecklist` narrowing so the fixture cannot drift from how config entries actually become definitions.
 *
 * `required` defaults to TRUE here, unlike in the config itself where it is mandatory and has no default.
 * That is not a divergence: this helper stands in for config that has ALREADY passed validation, and true
 * is the behavior every one of these tests was written against. A test that cares about the optional path
 * says `required: false` explicitly.
 */
function defs(items: readonly RawItem[], reviewer: ReviewerAgentPolicy = REVIEWER): ChecklistDefinition[] {
    return items.map((i: RawItem): ChecklistDefinition => toChecklist({ required: true, ...i }, reviewer));
}

// The production collaborators, from the shipped container: their git is the scripted repository above.
function newAiBranchName(): AiBranchName {
    return feature.container.get(AiBranchName);
}

function newForkPoint(): ForkPoint {
    return feature.container.get(ForkPoint);
}

/**
 * A HomeConfigService that answers from THIS argument and never opens a file.
 *
 * The real one reads `~/.webpieces/config.json`, and the machine running these tests may well have
 * `turnOffAllReviewers: true` in it — which would empty every expectation below for a reason that has
 * nothing to do with the code under test. Every construction states the flag out loud instead.
 */
function homeConfigWith(turnOffAllReviewers: boolean): HomeConfigService {
    const service = new HomeConfigService();
    vi.spyOn(service, 'load').mockReturnValue(
        new HomeConfig(false, false, DEFAULT_MAX_CONCURRENT_BUILDS, turnOffAllReviewers));
    return service;
}

// The production scanner — every collaborator from the shipped container — with the machine-local home
// config pinned, so the developer's own `~/.webpieces/config.json` cannot change an expectation.
function scannerFor(turnOffAllReviewers = false): ChecklistScanner {
    const c = feature.container;
    return new ChecklistScanner(
        c.get(AiBranchName), c.get(ChecklistDetector), c.get(DiffScope), c.get(DiffBasisResolver),
        c.get(PrContextWriter), c.get(ReviewJsonService), homeConfigWith(turnOffAllReviewers),
        c.get(ChecklistScopeHasher), c.get(VerdictProvenanceService), c.get(ReviewStageReceiptService),
        c.get(ReviewRoundStateService),
    );
}

/**
 * A verdict exactly as `wp-write-review` leaves it (issue #863): the file AND its provenance, stamped with
 * the checklist's CURRENT scope hash so it stands. A bare JSON file is now a hand-written verdict, and the
 * scan rejects it — see the provenance describe below.
 */
/** Stage ②'s round-1 receipt, briefing every checklist that applies now (written once). */
async function briefRound1(dir: string, checklists: ChecklistDefinition[]): Promise<ChecklistScan> {
    const receipts = new ReviewStageReceiptService(new ReviewJsonService());
    const scan = await scannerFor().scan(dir, checklists, new ChecklistScanOptions(1, false, ''));
    fs.mkdirSync(path.dirname(scan.summaryPath), { recursive: true });
    if (receipts.read(dir, await newAiBranchName().getFeatureName()) === null) {
        const receipt = new ReviewStageReceipt(scan.basis.headSha, true, 'pnpm build', 'now',
            scan.applicable.map((r: RequiredChecklist): string => r.id));
        receipt.round = 1;
        receipt.maxReviewerRounds = 1;
        receipt.scopeHashes = scan.scopeHashes;
        receipts.write(dir, await newAiBranchName().getFeatureName(), receipt);
    }
    return scan;
}

/**
 * What stage ② + `wp-write-review` leave behind: a round-1 receipt briefing every applicable checklist
 * (written once), and one bin-submitted round-1 verdict with its provenance.
 */
async function submitVerdict(dir: string, checklists: ChecklistDefinition[], id: string, status: string, output: string): Promise<void> {
    const reviewJson = new ReviewJsonService();
    const scan = await briefRound1(dir, checklists);
    const record = new VerdictProvenance(id, 'claude-code', 'sess-1', 'agent-1', 'webpieces-reviewer', scan.basis.headSha, scan.scopeHashes[id] ?? '');
    record.round = 1;
    new VerdictProvenanceService(reviewJson, new AtomicFile()).write(
        scan.summaryPath, new SubmittedVerdict(id, status, 'claude', 'opus', output), record);
}

describe('ChecklistScanner — reviewerAgents zero project policy', () => {
    it('suppresses matched required reviews while preserving what matched', async () => {
        const dir = repoOnBranch();
        fs.writeFileSync(path.join(dir, 'change.sql'), 'SELECT 1;\n');
        const disabled = defs(
            [{ id: 'db-reviewer', patterns: ['**/*.sql'] }],
            new ReviewerAgentPolicy('webpieces-reviewer', 0));

        const scan = await scannerFor(false).scan(dir, disabled, new ChecklistScanOptions(1, true));

        expect(scan.reviewersDisabled).toBe(true);
        expect(scan.applicable).toEqual([]);
        expect(scan.outstanding).toEqual([]);
        expect(scan.suppressed.map((r: RequiredChecklist): string => r.id)).toEqual(['db-reviewer']);
    });

    it('leaves positive reviewer caps unchanged', async () => {
        const dir = repoOnBranch();
        fs.writeFileSync(path.join(dir, 'change.sql'), 'SELECT 1;\n');
        const enabled = defs(
            [{ id: 'db-reviewer', patterns: ['**/*.sql'] }],
            new ReviewerAgentPolicy('webpieces-reviewer', 1));

        const scan = await scannerFor(false).scan(dir, enabled, new ChecklistScanOptions(1, true));

        expect(scan.reviewersDisabled).toBe(false);
        expect(scan.applicable).toHaveLength(1);
        expect(scan.outstanding).toHaveLength(1);
    });
});

describe('ChecklistScanner — UNCOMMITTED work counts', () => {
    // These env vars ARE the regression: DiffScope.resolveBase overlays them, and an NX_HEAD turns
    // getChangedFiles into a commit-to-commit diff that drops the working tree entirely. The scanner must
    // never consult them.
    beforeEach(() => {
        delete process.env['NX_BASE'];
        delete process.env['NX_HEAD'];
    });
    afterEach(() => {
        delete process.env['NX_BASE'];
        delete process.env['NX_HEAD'];
    });

    it('matches a checklist on a MODIFIED-but-uncommitted file', async () => {
        const dir = repoOnBranch();
        const checklists = defs([{ id: 'db-reviewer', patterns: ['**/*.sql'] }]);
        fs.mkdirSync(path.join(dir, 'db'));
        fs.writeFileSync(path.join(dir, 'db', '001.sql'), 'CREATE TABLE a();\n');
        repo.commitAll('work');
        fs.writeFileSync(path.join(dir, 'db', '001.sql'), 'CREATE TABLE a(); -- edited\n'); // NOT committed
        const scan = await scannerFor().scan(dir, checklists, new ChecklistScanOptions(1, false));
        expect(scan.applicable.map((r: RequiredChecklist): string => r.id)).toEqual(['db-reviewer']);
    });

    it('matches a checklist on an UNTRACKED file', async () => {
        const dir = repoOnBranch();
        const checklists = defs([{ id: 'db-reviewer', patterns: ['**/*.sql'] }]);
        fs.mkdirSync(path.join(dir, 'db'));
        fs.writeFileSync(path.join(dir, 'db', '002.sql'), 'CREATE TABLE b();\n'); // never `git add`ed
        const scan = await scannerFor().scan(dir, checklists, new ChecklistScanOptions(1, false));
        expect(scan.applicable.map((r: RequiredChecklist): string => r.id)).toEqual(['db-reviewer']);
        expect(scan.applicable[0].matchedFiles).toContain('db/002.sql');
    });

    // THE regression. With NX_HEAD set, the old path diffed commit-to-commit and the uncommitted .sql
    // vanished — so the reviewer that must run was never listed, purely because of an env var.
    it('STILL matches uncommitted work when NX_BASE / NX_HEAD are set', async () => {
        const dir = repoOnBranch();
        const checklists = defs([{ id: 'db-reviewer', patterns: ['**/*.sql'] }]);
        fs.mkdirSync(path.join(dir, 'db'));
        fs.writeFileSync(path.join(dir, 'db', '003.sql'), 'CREATE TABLE c();\n');
        process.env['NX_BASE'] = 'main';
        process.env['NX_HEAD'] = 'HEAD';
        const scan = await scannerFor().scan(dir, checklists, new ChecklistScanOptions(1, false));
        expect(scan.applicable.map((r: RequiredChecklist): string => r.id)).toEqual(['db-reviewer']);
    });

    // tsOnly defaults to true in DiffScope and would drop .sql / Dockerfile / .env* — the files a checklist
    // most wants to key on. The scanner must override it.
    it('sees non-.ts files (tsOnly:false)', async () => {
        const dir = repoOnBranch();
        const checklists = defs([{ id: 'ops-reviewer', patterns: ['**/Dockerfile', '**/.env*'] }]);
        fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node\n');
        expect((await scannerFor().scan(dir, checklists, new ChecklistScanOptions(1, false))).applicable).toHaveLength(1);
    });
});

describe('ChecklistScanner — X / N / Z', () => {
    // X = 4 defined. The repo below changes a .sql and a Dockerfile, so N = 2 (db + ops); the .css and
    // *Api.ts checklists must NOT fire.
    const FOUR = defs([
        { id: 'db-reviewer', patterns: ['**/*.sql'] },
        { id: 'ops-reviewer', patterns: ['**/Dockerfile'] },
        { id: 'ui-reviewer', patterns: ['**/*.css'] },
        { id: 'api-reviewer', patterns: ['**/*Api.ts'] },
    ]);

    function repoWithFour(): string {
        const dir = repoOnBranch();
        fs.mkdirSync(path.join(dir, 'db'));
        fs.writeFileSync(path.join(dir, 'db', '001.sql'), 'x\n');
        fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node\n');
        return dir;
    }

    it('reports X and N', async () => {
        const scan = await scannerFor().scan(repoWithFour(), FOUR, new ChecklistScanOptions(1, false));
        expect(scan.defined).toHaveLength(4);
        expect(scan.applicable.map((r: RequiredChecklist): string => r.id).sort()).toEqual(['db-reviewer', 'ops-reviewer']);
    });

    it('filterAlreadyReviewed:false leaves outstanding == applicable, so wp-review-upsert-pr LISTS them all', async () => {
        const scan = await scannerFor().scan(repoWithFour(), FOUR, new ChecklistScanOptions(1, false));
        expect(scan.outstanding).toHaveLength(2);
        expect(scan.reviewed).toHaveLength(0);
    });

    it('filterAlreadyReviewed:true narrows N to Z — only what still owes a verdict', async () => {
        const dir = repoWithFour();
        await submitVerdict(dir, FOUR, 'db-reviewer', 'green', 'ok');
        const scan = await scannerFor().scan(dir, FOUR, new ChecklistScanOptions(1, true));
        expect(scan.applicable).toHaveLength(2);                                                         // N
        expect(scan.reviewed.map((r: RequiredChecklist): string => r.id)).toEqual(['db-reviewer']);
        expect(scan.outstanding.map((r: RequiredChecklist): string => r.id)).toEqual(['ops-reviewer']);   // Z
    });

    // "Review once" is per subagent: 2 of 4 done means the other 2 still need running, so a FAILED verdict
    // with no override still owes review and must stay in Z. The ship-anyway authorization is a SEPARATE
    // file the coordinating agent writes (override-<id>.json), never a field in the reviewer's verdict.
    it('an un-overridden FAIL still owes review; an OVERRIDDEN one does not', async () => {
        const dir = repoWithFour();
        const svc = new ReviewJsonService();
        const summaryPath = svc.summaryJsonPath(dir, await newAiBranchName().getFeatureName());
        fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
        await submitVerdict(dir, FOUR, 'db-reviewer', 'red', 'bad');
        await submitVerdict(dir, FOUR, 'ops-reviewer', 'red', 'bad');
        fs.writeFileSync(checklistOverrideService.overridePath(summaryPath, 'ops-reviewer'), JSON.stringify(
            new ChecklistOverride('ops-reviewer', 'human, in-session', '2026-09-03T18:22:11Z', 'accepted, JIRA-1')));
        const scan = await scannerFor().scan(dir, FOUR, new ChecklistScanOptions(1, true));
        expect(scan.outstanding.map((r: RequiredChecklist): string => r.id)).toEqual(['db-reviewer']);
    });

});

// Same fixture, split out to keep each describe inside the method-length limit.
describe('ChecklistScanner — degenerate and always-write cases', () => {
    const FOUR = defs([
        { id: 'db-reviewer', patterns: ['**/*.sql'] },
        { id: 'ops-reviewer', patterns: ['**/Dockerfile'] },
    ]);

    function repoWithFour(): string {
        const dir = repoOnBranch();
        fs.mkdirSync(path.join(dir, 'db'));
        fs.writeFileSync(path.join(dir, 'db', '001.sql'), 'x\n');
        fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node\n');
        return dir;
    }

    it('a repo with no checklists scans clean rather than erroring', async () => {
        const dir = repoOnBranch();
        const scan = await scannerFor().scan(dir, defs([]), new ChecklistScanOptions(1, true));
        expect(scan.defined).toEqual([]);
        expect(scan.applicable).toEqual([]);
        expect(scan.outstanding).toEqual([]);
    });

    it('always writes pr-context.json, so no reviewer block can lose its diff command', async () => {
        const dir = repoWithFour();
        const scan = await scannerFor().scan(dir, FOUR, new ChecklistScanOptions(1, false));
        expect(fs.existsSync(scan.context.prContextPath)).toBe(true);
        expect(scan.context.baseSha).toBe(scan.forkPoint);
    });

    /**
     * Writing is what you get by DEFAULT; opting out is explicit. A reviewer block that lost its diff
     * command because nobody wrote pr-context.json is a bug this codebase already shipped once, so the
     * opt-out has to be a visible act by a caller that writes it later (stage ②, after materializing) —
     * never an omission.
     */
    it('writes a per-stage snapshot beside pr-context.json, so earlier states survive for debugging', async () => {
        const dir = repoWithFour();
        const scan = await scannerFor().scan(dir, FOUR, new ChecklistScanOptions(1, false, 'stage3-finish'));
        const snapshot = path.join(path.dirname(scan.context.prContextPath), 'stages', 'stage3-finish.json');
        expect(fs.existsSync(snapshot)).toBe(true);
        // The snapshot is a byte-for-byte copy of what pr-context.json said AT THAT STAGE — the point is
        // that a later stage overwriting pr-context.json cannot destroy it.
        expect(fs.readFileSync(snapshot, 'utf8')).toBe(fs.readFileSync(scan.context.prContextPath, 'utf8'));
    });

    it('contextStage:"" skips the write, for the one caller that writes it itself afterwards', async () => {
        const dir = repoWithFour();
        const scan = await scannerFor().scan(dir, FOUR, new ChecklistScanOptions(1, false, ''));
        expect(fs.existsSync(scan.context.prContextPath)).toBe(false);
        // …but the context still names WHERE it will be, so a caller can point at it before it exists.
        expect(scan.context.prContextPath).not.toBe('');
        expect(scan.context.baseSha).toBe(scan.forkPoint);
    });
});

describe('ForkPoint.resolveForkPoint — absolute, and no fetch', () => {
    it('is unchanged when main advances past the branch', async () => {
        const dir = repoOnBranch();
        fs.writeFileSync(path.join(dir, 'f.txt'), 'feature\n');
        repo.commitAll('feat');
        const forkPoint = newForkPoint();
        const before = await forkPoint.resolveForkPoint(dir);

        // Advance main via a side branch + `git branch -f`: a commit lands on main that is not on this branch.
        const moved = repo.advanceBranch('main', 'm.txt', 'main moved\n', 'mainwork');
        expect(moved).not.toBe(before);

        // merge-base is the most recent common ancestor; main's new commit is not on this branch, so
        // advancing main cannot move it. THIS is why wp-review-upsert-pr need not fetch.
        expect(await forkPoint.resolveForkPoint(dir)).toBe(before);
    });

    it("returns '' rather than throwing when neither origin/main nor main resolves", async () => {
        const dir = repoWithoutMain('wp-nomain-', 'a.txt');
        // wp-review-upsert-pr must ALWAYS succeed, so an unresolvable fork point is a value, never an exception.
        expect(await newForkPoint().resolveForkPoint(dir)).toBe('');
    });

    it('a scan with no fork point yields no checklists instead of blowing up', async () => {
        const dir = repoWithoutMain('wp-nomain2-', 'a.sql');
        const checklists = defs([{ id: 'db-reviewer', patterns: ['**/*.sql'] }]);
        const scan = await scannerFor().scan(dir, checklists, new ChecklistScanOptions(1, false));
        expect(scan.forkPoint).toBe('');
        expect(scan.applicable).toEqual([]);
    });
});

// Shared by the two roster describes below (split only to stay inside the method-length limit): 4 defined,
// of which the .sql and Dockerfile ones fire and the .css / *Api.ts ones are evaluated and skipped.
const ROSTER_FOUR = defs([
    { id: 'db-reviewer', patterns: ['**/*.sql'] },
    { id: 'ops-reviewer', patterns: ['**/Dockerfile'] },
    { id: 'ui-reviewer', patterns: ['**/*.css'] },
    { id: 'api-reviewer', patterns: ['**/*Api.ts'] },
]);

function repoForRoster(): string {
    const dir = repoOnBranch();
    fs.mkdirSync(path.join(dir, 'db'));
    fs.writeFileSync(path.join(dir, 'db', '001.sql'), 'x\n');
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node\n');
    return dir;
}

// The verdict-file path the scanner reads, with `dir`'s review dir created.
async function verdictPath(dir: string, id: string): Promise<string> {
    const svc = new ReviewJsonService();
    const summaryPath = svc.summaryJsonPath(dir, await newAiBranchName().getFeatureName());
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    return svc.checklistResultPath(summaryPath, id, 1);
}

// The roster is what the PR comment publishes: every defined checklist, matched or not.
describe('ChecklistScanner — roster (all X, matched or not)', () => {
    const FOUR = ROSTER_FOUR;
    const repoWithFour = repoForRoster;

    it('carries an entry for every DEFINED checklist, including the two that matched nothing', async () => {
        const scan = await scannerFor().scan(repoWithFour(), FOUR, new ChecklistScanOptions(1, false));
        expect(scan.roster.entries.map((t: TriggeredChecklist): string => t.def.id))
            .toEqual(['db-reviewer', 'ops-reviewer', 'ui-reviewer', 'api-reviewer']);
        const skipped = scan.roster.entries.filter((t: TriggeredChecklist): boolean => t.matchedFiles.length === 0);
        expect(skipped.map((t: TriggeredChecklist): string => t.def.id)).toEqual(['ui-reviewer', 'api-reviewer']);
    });

    it('counts the changed files considered, so "matched 0 of N" has an honest N', async () => {
        const scan = await scannerFor().scan(repoWithFour(), FOUR, new ChecklistScanOptions(1, false));
        expect(scan.roster.changedFileCount).toBe(2);   // db/001.sql + Dockerfile (untracked, uncommitted)
        expect(scan.roster.baseResolved).toBe(true);
    });

    // The false-all-clear guard. With no fork point NOTHING matches — not even a patternless checklist — so
    // an "all skipped ✅" roll-up would attest to a review that never happened.
    it('flags an unresolvable diff base rather than letting zero matches read as all-clear', async () => {
        const dir = repoWithoutMain('wp-nobase-', 'a.sql');
        const scan = await scannerFor().scan(dir, FOUR, new ChecklistScanOptions(1, false));
        expect(scan.roster.baseResolved).toBe(false);
        expect(scan.roster.entries).toHaveLength(4);          // still fully listed
        expect(scan.roster.changedFileCount).toBe(0);
        expect(scan.applicable).toEqual([]);
    });
});

/**
 * `required: false` — the reviewer may be declined, but its ANSWER still counts.
 *
 * These pin the one asymmetry the whole feature turns on: a matched optional checklist with NO verdict is
 * exempt from `outstanding` (nobody ran it, and nobody had to), while the same checklist with a RED verdict
 * is not (it ran, it objected, and choosing to ignore that would make running it pointless).
 */
describe('ChecklistScanner — optional checklists', () => {
    // Both match the fixture repo. One blocks, one is offered.
    const MIXED = defs([
        { id: 'db-reviewer', patterns: ['**/*.sql'], required: true },
        { id: 'ops-reviewer', patterns: ['**/Dockerfile'], required: false },
    ]);

    it('carries `required` from config through to the matched set', async () => {
        const scan = await scannerFor().scan(repoForRoster(), MIXED, new ChecklistScanOptions(1, false));
        expect(scan.applicable.map((r: RequiredChecklist): boolean => r.required)).toEqual([true, false]);
    });

    it('does NOT owe a verdict for an optional checklist nobody ran — that is the whole point', async () => {
        const dir = repoForRoster();
        await submitVerdict(dir, MIXED, 'db-reviewer', 'green', 'ok');
        const scan = await scannerFor().scan(dir, MIXED, new ChecklistScanOptions(1, true));
        expect(scan.outstanding).toEqual([]);
        // Reported as NOT RUN — never folded into `reviewed`, which would put a ✓ on a review that never happened.
        expect(scan.optionalNotRun.map((r: RequiredChecklist): string => r.id)).toEqual(['ops-reviewer']);
        expect(scan.reviewed.map((r: RequiredChecklist): string => r.id)).toEqual(['db-reviewer']);
    });

    it('STILL owes it once that optional reviewer has run and gone red — running one is not ignoring one', async () => {
        const dir = repoForRoster();
        await submitVerdict(dir, MIXED, 'db-reviewer', 'green', 'ok');
        await submitVerdict(dir, MIXED, 'ops-reviewer', 'red', 'runs as root');
        const scan = await scannerFor().scan(dir, MIXED, new ChecklistScanOptions(1, true));
        expect(scan.outstanding.map((r: RequiredChecklist): string => r.id)).toEqual(['ops-reviewer']);
        expect(scan.optionalNotRun).toEqual([]);
    });

    it('a REQUIRED checklist with no verdict is still outstanding — the exemption is optional-only', async () => {
        const scan = await scannerFor().scan(repoForRoster(), MIXED, new ChecklistScanOptions(1, true));
        expect(scan.outstanding.map((r: RequiredChecklist): string => r.id)).toEqual(['db-reviewer']);
    });

    // An unreadable verdict file is not "not run": the reviewer left something behind, and it has to be
    // fixed rather than silently forgiven because the checklist happened to be optional.
    it('does not exempt an optional checklist whose verdict file is UNREADABLE', async () => {
        const dir = repoForRoster();
        await submitVerdict(dir, MIXED, 'db-reviewer', 'green', 'ok');
        fs.writeFileSync(await verdictPath(dir, 'ops-reviewer'),
            JSON.stringify({ id: 'ops-reviewer', success: true, output: 'ok' }));
        const scan = await scannerFor().scan(dir, MIXED, new ChecklistScanOptions(1, true));
        expect(scan.formatErrors).toHaveLength(1);
        expect(scan.outstanding.map((r: RequiredChecklist): string => r.id)).toEqual(['ops-reviewer']);
        expect(scan.optionalNotRun).toEqual([]);
    });
});

describe('ChecklistScanner — verdict file formats', () => {
    // A verdict file in the removed `success` format must not masquerade as a missing one, or the AI re-runs
    // a reviewer that already ran instead of correcting four characters of JSON.
    it('reports a legacy `success` verdict file as a format error, and still owes the review', async () => {
        const dir = repoForRoster();
        await briefRound1(dir, ROSTER_FOUR);
        fs.writeFileSync(await verdictPath(dir, 'db-reviewer'),
            JSON.stringify({ id: 'db-reviewer', success: true, output: 'ok' }));
        const scan = await scannerFor().scan(dir, ROSTER_FOUR, new ChecklistScanOptions(1, true));
        expect(scan.formatErrors).toHaveLength(1);
        expect(scan.formatErrors[0]).toContain('"success"');
        expect(scan.outstanding.map((r: RequiredChecklist): string => r.id).sort())
            .toEqual(['db-reviewer', 'ops-reviewer']);
    });

    it('has no format errors when every verdict uses the tri-state status', async () => {
        const dir = repoForRoster();
        await submitVerdict(dir, ROSTER_FOUR, 'db-reviewer', 'yellow', 'no CONCURRENTLY');
        const scan = await scannerFor().scan(dir, ROSTER_FOUR, new ChecklistScanOptions(1, true));
        expect(scan.formatErrors).toEqual([]);
        // yellow SHIPS — it must not be listed as still owing a verdict.
        expect(scan.outstanding.map((r: RequiredChecklist): string => r.id)).toEqual(['ops-reviewer']);
    });
});

describe('ChecklistScanner — patternless checklists always apply', () => {
    it('a checklist with no patterns is applicable on any change', async () => {
        const dir = repoOnBranch();
        const checklists = defs([{ id: 'security-reviewer' }]);
        fs.writeFileSync(path.join(dir, 'anything.txt'), 'x\n');
        const scan = await scannerFor().scan(dir, checklists, new ChecklistScanOptions(1, false));
        expect(scan.applicable).toHaveLength(1);
        // [] matchedPatterns is what makes it render as ALWAYS RUNS rather than claiming a "match".
        expect(scan.applicable[0].matchedPatterns).toEqual([]);
    });

    it('carries the repo-wide reviewer policy onto every matched checklist', async () => {
        const dir = repoOnBranch();
        fs.writeFileSync(path.join(dir, 'anything.txt'), 'x\n');
        const scan = await scannerFor().scan(dir, defs([{ id: 'a' }, { id: 'b' }]), new ChecklistScanOptions(1, false));
        expect(scan.applicable.map((r: RequiredChecklist): string => r.reviewer.agentName)).toEqual(['webpieces-reviewer', 'webpieces-reviewer']);
    });
});

/**
 * ══ experimental.turnOffAllReviewers — the ONE choke point ══════════════════════════════════════════
 *
 * The flag is read HERE and nowhere else, which is what keeps `wp-review-upsert-pr` (which lists) and
 * `wp-finish-upsert-pr` (which blocks) in agreement by construction. Both call this scan, so a scan that
 * owes nothing is a PR that is neither told to spawn nor refused for not having.
 *
 * REQUIRED checklists are suppressed too, deliberately — see HOME_KEY_TURN_OFF_ALL_REVIEWERS. That is
 * the assertion below that would be tempting to soften and must not be.
 */
describe('ChecklistScanner — turnOffAllReviewers', () => {
    const TWO_REQUIRED = defs([
        { id: 'db-reviewer', patterns: ['**/*.sql'], required: true },
        { id: 'ops-reviewer', patterns: ['**/Dockerfile'], required: true },
    ]);

    function repoWithBoth(): string {
        const dir = repoOnBranch();
        fs.mkdirSync(path.join(dir, 'db'));
        fs.writeFileSync(path.join(dir, 'db', '001.sql'), 'x\n');
        fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node\n');
        return dir;
    }

    it('OFF (the default): the two REQUIRED checklists apply and are outstanding — unchanged behaviour', async () => {
        const scan = await scannerFor(false).scan(repoWithBoth(), TWO_REQUIRED, new ChecklistScanOptions(1, true));
        expect(scan.applicable.map((r: RequiredChecklist): string => r.id).sort())
            .toEqual(['db-reviewer', 'ops-reviewer']);
        expect(scan.outstanding).toHaveLength(2);
        expect(scan.reviewersDisabled).toBe(false);
        expect(scan.suppressed).toEqual([]);
    });

    it('ON: applicable and outstanding are EMPTY even though both REQUIRED checklists match', async () => {
        const scan = await scannerFor(true).scan(repoWithBoth(), TWO_REQUIRED, new ChecklistScanOptions(1, true));
        expect(scan.applicable).toEqual([]);
        expect(scan.outstanding).toEqual([]);
        expect(scan.reviewed).toEqual([]);
        expect(scan.results).toEqual([]);
        expect(scan.optionalNotRun).toEqual([]);
        expect(scan.formatErrors).toEqual([]);
    });

    // The whole point of carrying `suppressed`: an empty `applicable` is ambiguous on its own, and the
    // count + names are what stage ②, the dashboard and main's commit history all report from.
    it('ON: records WHAT was suppressed, by name, with `required` intact', async () => {
        const scan = await scannerFor(true).scan(repoWithBoth(), TWO_REQUIRED, new ChecklistScanOptions(1, true));
        expect(scan.reviewersDisabled).toBe(true);
        expect(scan.suppressed.map((r: RequiredChecklist): string => r.id).sort())
            .toEqual(['db-reviewer', 'ops-reviewer']);
        expect(scan.suppressed.every((r: RequiredChecklist): boolean => r.required)).toBe(true);
    });

    // `defined`, `roster`, `changedFiles` and `basis` must survive: without them nothing downstream can
    // say WHAT was switched off, and the suppression becomes exactly the silent skip this must never be.
    it('ON: keeps defined, the roster and the changed-file set intact', async () => {
        const scan = await scannerFor(true).scan(repoWithBoth(), TWO_REQUIRED, new ChecklistScanOptions(1, true));
        expect(scan.defined).toHaveLength(2);
        expect(scan.roster.entries).toHaveLength(2);
        expect(scan.changedFiles).toContain('db/001.sql');
        expect(scan.basis.base).not.toEqual('');
    });

    // Suppressing must not resurrect the ambiguity in the other direction either: a repo where nothing
    // matched reports 0 suppressed, so "0 applicable" and "4 killed" stay tellable apart.
    it('ON: a diff that matches NOTHING reports zero suppressed, not a phantom count', async () => {
        const dir = repoOnBranch();
        fs.writeFileSync(path.join(dir, 'notes.md'), 'hi\n');
        const scan = await scannerFor(true).scan(dir, TWO_REQUIRED, new ChecklistScanOptions(1, true));
        expect(scan.reviewersDisabled).toBe(true);
        expect(scan.suppressed).toEqual([]);
    });
});

/**
 * Issue #863: a verdict counts only when `wp-write-review` wrote it, and a green or yellow CARRIES across
 * rounds only while its checklist's in-scope diff is unchanged. These pin both halves at the one scan that
 * stage ② (which briefs) and stage ③ (which blocks) share.
 */
describe('ChecklistScanner — verdict provenance and carry-over (issue #863)', () => {
    const MIXED = defs([
        { id: 'db-reviewer', patterns: ['**/*.sql'] },
        { id: 'ops-reviewer', patterns: ['**/Dockerfile'] },
    ]);

    function standingOf(standings: readonly VerdictStanding[], id: string): VerdictStanding | undefined {
        return standings.find((s: VerdictStanding): boolean => s.checklistId === id);
    }

    it('REJECTS a hand-written verdict — the forgery a Codex coordinator got through finish — and still owes it', async () => {
        const dir = repoForRoster();
        fs.writeFileSync(await verdictPath(dir, 'db-reviewer'),
            JSON.stringify({ agent: 'codex', model: 'gpt', id: 'db-reviewer', status: 'green', output: 'ok' }));
        const scan = await scannerFor().scan(dir, MIXED, new ChecklistScanOptions(1, true));
        expect(standingOf(scan.standings, 'db-reviewer')?.standing).toBe(STANDING_REJECTED);
        expect(standingOf(scan.standings, 'db-reviewer')?.reason).toContain('wp-write-review');
        expect(scan.reviewed).toEqual([]);
        expect(scan.outstanding.map((r: RequiredChecklist): string => r.id)).toContain('db-reviewer');
    });

    it('REJECTS a bin-written verdict that was edited afterwards', async () => {
        const dir = repoForRoster();
        await submitVerdict(dir, MIXED, 'db-reviewer', 'red', 'drops a column');
        fs.writeFileSync(await verdictPath(dir, 'db-reviewer'),
            JSON.stringify({ agent: 'claude', model: 'opus', id: 'db-reviewer', status: 'green', output: 'drops a column' }));
        const scan = await scannerFor().scan(dir, MIXED, new ChecklistScanOptions(1, true));
        expect(standingOf(scan.standings, 'db-reviewer')?.standing).toBe(STANDING_REJECTED);
        expect(standingOf(scan.standings, 'db-reviewer')?.reason).toContain('EDITED');
    });

    it('CARRIES a green whose in-scope files are unchanged, even though another checklist\'s files moved', async () => {
        const dir = repoForRoster();
        await submitVerdict(dir, MIXED, 'db-reviewer', 'green', 'ok');
        fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node:22\n'); // ops scope only
        const scan = await scannerFor().scan(dir, MIXED, new ChecklistScanOptions(1, true));
        expect(standingOf(scan.standings, 'db-reviewer')?.standing).toBe(STANDING_CURRENT);
        expect(scan.reviewed.map((r: RequiredChecklist): string => r.id)).toEqual(['db-reviewer']);
    });

    // Issue #1053: staleness never triggers a re-review. The green judged earlier code and says so, and stands.
    it('CARRIES a green whose in-scope files CHANGED — staleness never re-reviews', async () => {
        const dir = repoForRoster();
        await submitVerdict(dir, MIXED, 'db-reviewer', 'green', 'ok');
        fs.writeFileSync(path.join(dir, 'db', '001.sql'), 'DROP TABLE a;\n');
        const scan = await scannerFor().scan(dir, MIXED, new ChecklistScanOptions(1, true));
        expect(standingOf(scan.standings, 'db-reviewer')?.standing).toBe(STANDING_CARRIED);
        expect(standingOf(scan.standings, 'db-reviewer')?.reason).toContain('CARRIED FORWARD without re-review');
        expect(scan.reviewed.map((r: RequiredChecklist): string => r.id)).toContain('db-reviewer');
        expect(scan.outstanding.map((r: RequiredChecklist): string => r.id)).not.toContain('db-reviewer');
    });

    it('never carries a RED: unchanged scope or not, it stays owed and keeps refusing', async () => {
        const dir = repoForRoster();
        await submitVerdict(dir, MIXED, 'db-reviewer', 'red', 'drops a column');
        const unchanged = await scannerFor().scan(dir, MIXED, new ChecklistScanOptions(1, true));
        expect(unchanged.reviewed).toEqual([]);
        expect(unchanged.outstanding.map((r: RequiredChecklist): string => r.id)).toContain('db-reviewer');
        fs.writeFileSync(path.join(dir, 'db', '001.sql'), 'ALTER TABLE a;\n');
        const changed = await scannerFor().scan(dir, MIXED, new ChecklistScanOptions(1, true));
        expect(changed.results.map((r: ChecklistResult): string => r.id)).toContain('db-reviewer');
        expect(changed.outstanding.map((r: RequiredChecklist): string => r.id)).toContain('db-reviewer');
    });

});
