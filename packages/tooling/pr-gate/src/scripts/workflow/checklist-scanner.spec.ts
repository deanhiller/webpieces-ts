import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    ChecklistDefinition, DiffScope, HumanApproval, HumanAuthorizationService, RequiredChecklist,
    ReviewJsonService, toChecklist,
} from '@webpieces/rules-config';
import { ReviewChangedFiles } from './authorization-context-resolver';
import { ChecklistDetector, TriggeredChecklist } from './checklist-detector';
import { ChecklistScanner, ChecklistScanOptions } from './checklist-scanner';
import { ForkPoint } from './git-findForkPoint';
import { GitStatusParser } from './git-status';
import { DiffBasisResolver } from './diff-basis';
import { PrContextWriter } from './pr-context-writer';
import { AiBranchName } from './git-readAiBranchName';
import { BranchNaming } from './branch-naming';

// Any committed-looking salt: these tests care that a SIGNED approval verifies and an unsigned one does not,
// not what the key is.
const SALT = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

function git(cwd: string, cmd: string): void {
    execSync(cmd, { cwd, stdio: 'pipe' });
}

/**
 * A real git repo with `main` at a baseline commit and a feature branch checked out. Real git because these
 * tests are precisely about which git plumbing gets invoked — a mock would only re-assert the mock.
 */
function repoOnBranch(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-scan-'));
    git(dir, 'git init -q -b main');
    git(dir, 'git config user.email t@t.co');
    git(dir, 'git config user.name T');
    fs.writeFileSync(path.join(dir, 'README.md'), '# base\n');
    git(dir, 'git add -A');
    git(dir, 'git commit -qm base');
    git(dir, 'git checkout -q -b feature');
    return dir;
}

/** One raw config entry as a fixture. `required` is omitted by most tests — see {@link defs}. */
interface RawItem { subagent?: string; doc?: string; patterns?: string[]; required?: boolean }

/**
 * The already-validated `prGate.checklists` a command would hand the scanner. Built through the real
 * `toChecklist` narrowing so the fixture cannot drift from how config entries actually become definitions.
 *
 * `required` defaults to TRUE here, unlike in the config itself where it is mandatory and has no default.
 * That is not a divergence: this helper stands in for config that has ALREADY passed validation, and true
 * is the behavior every one of these tests was written against. A test that cares about the optional path
 * says `required: false` explicitly.
 */
function defs(items: readonly RawItem[]): ChecklistDefinition[] {
    return items.map((i: RawItem): ChecklistDefinition => toChecklist({ required: true, ...i }));
}

function newAiBranchName(): AiBranchName {
    return new AiBranchName(new BranchNaming());
}

function newForkPoint(): ForkPoint {
    return new ForkPoint(null as never, null as never, null as never);
}

function scannerFor(): ChecklistScanner {
    const diffScope = new DiffScope();
    const reviewJson = new ReviewJsonService();
    // A REAL DiffBasisResolver over a REAL ForkPoint: these tests exist to pin which git plumbing runs, and
    // the basis is now part of that plumbing (it is what makes the printed command match the matched range).
    return new ChecklistScanner(
        newAiBranchName(), new ChecklistDetector(diffScope), new ReviewChangedFiles(diffScope),
        new DiffBasisResolver(newForkPoint(), new GitStatusParser()),
        new PrContextWriter(diffScope, reviewJson), reviewJson, new HumanAuthorizationService(),
    );
}

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

    it('matches a checklist on a MODIFIED-but-uncommitted file', () => {
        const dir = repoOnBranch();
        const checklists = defs([{ subagent: 'db-reviewer', patterns: ['**/*.sql'] }]);
        fs.mkdirSync(path.join(dir, 'db'));
        fs.writeFileSync(path.join(dir, 'db', '001.sql'), 'CREATE TABLE a();\n');
        git(dir, 'git add -A');
        git(dir, 'git commit -qm work');
        fs.writeFileSync(path.join(dir, 'db', '001.sql'), 'CREATE TABLE a(); -- edited\n'); // NOT committed
        const scan = scannerFor().scan(dir, checklists, SALT, new ChecklistScanOptions(false));
        expect(scan.applicable.map((r: RequiredChecklist): string => r.id)).toEqual(['db-reviewer']);
    });

    it('matches a checklist on an UNTRACKED file', () => {
        const dir = repoOnBranch();
        const checklists = defs([{ subagent: 'db-reviewer', patterns: ['**/*.sql'] }]);
        fs.mkdirSync(path.join(dir, 'db'));
        fs.writeFileSync(path.join(dir, 'db', '002.sql'), 'CREATE TABLE b();\n'); // never `git add`ed
        const scan = scannerFor().scan(dir, checklists, SALT, new ChecklistScanOptions(false));
        expect(scan.applicable.map((r: RequiredChecklist): string => r.id)).toEqual(['db-reviewer']);
        expect(scan.applicable[0].matchedFiles).toContain('db/002.sql');
    });

    // THE regression. With NX_HEAD set, the old path diffed commit-to-commit and the uncommitted .sql
    // vanished — so the reviewer that must run was never listed, purely because of an env var.
    it('STILL matches uncommitted work when NX_BASE / NX_HEAD are set', () => {
        const dir = repoOnBranch();
        const checklists = defs([{ subagent: 'db-reviewer', patterns: ['**/*.sql'] }]);
        fs.mkdirSync(path.join(dir, 'db'));
        fs.writeFileSync(path.join(dir, 'db', '003.sql'), 'CREATE TABLE c();\n');
        process.env['NX_BASE'] = 'main';
        process.env['NX_HEAD'] = 'HEAD';
        const scan = scannerFor().scan(dir, checklists, SALT, new ChecklistScanOptions(false));
        expect(scan.applicable.map((r: RequiredChecklist): string => r.id)).toEqual(['db-reviewer']);
    });

    // tsOnly defaults to true in DiffScope and would drop .sql / Dockerfile / .env* — the files a checklist
    // most wants to key on. The scanner must override it.
    it('sees non-.ts files (tsOnly:false)', () => {
        const dir = repoOnBranch();
        const checklists = defs([{ subagent: 'ops-reviewer', patterns: ['**/Dockerfile', '**/.env*'] }]);
        fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node\n');
        expect(scannerFor().scan(dir, checklists, SALT, new ChecklistScanOptions(false)).applicable).toHaveLength(1);
    });
});

describe('ChecklistScanner — X / N / Z', () => {
    // X = 4 defined. The repo below changes a .sql and a Dockerfile, so N = 2 (db + ops); the .css and
    // *Api.ts checklists must NOT fire.
    const FOUR = defs([
        { subagent: 'db-reviewer', patterns: ['**/*.sql'] },
        { subagent: 'ops-reviewer', patterns: ['**/Dockerfile'] },
        { subagent: 'ui-reviewer', patterns: ['**/*.css'] },
        { subagent: 'api-reviewer', patterns: ['**/*Api.ts'] },
    ]);

    function repoWithFour(): string {
        const dir = repoOnBranch();
        fs.mkdirSync(path.join(dir, 'db'));
        fs.writeFileSync(path.join(dir, 'db', '001.sql'), 'x\n');
        fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node\n');
        return dir;
    }

    it('reports X and N', () => {
        const scan = scannerFor().scan(repoWithFour(), FOUR, SALT, new ChecklistScanOptions(false));
        expect(scan.defined).toHaveLength(4);
        expect(scan.applicable.map((r: RequiredChecklist): string => r.id).sort()).toEqual(['db-reviewer', 'ops-reviewer']);
    });

    it('filterAlreadyReviewed:false leaves outstanding == applicable, so wp-review-upsert-pr LISTS them all', () => {
        const scan = scannerFor().scan(repoWithFour(), FOUR, SALT, new ChecklistScanOptions(false));
        expect(scan.outstanding).toHaveLength(2);
        expect(scan.reviewed).toHaveLength(0);
    });

    it('filterAlreadyReviewed:true narrows N to Z — only what still owes a verdict', () => {
        const dir = repoWithFour();
        const svc = new ReviewJsonService();
        const reviewPath = svc.reviewJsonPath(dir, newAiBranchName().getFeatureName());
        fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
        fs.writeFileSync(svc.checklistResultPath(reviewPath, 'db-reviewer'),
            JSON.stringify({ id: 'db-reviewer', status: 'green', output: 'ok', override: '' }));
        const scan = scannerFor().scan(dir, FOUR, SALT, new ChecklistScanOptions(true));
        expect(scan.applicable).toHaveLength(2);                                                         // N
        expect(scan.reviewed.map((r: RequiredChecklist): string => r.id)).toEqual(['db-reviewer']);
        expect(scan.outstanding.map((r: RequiredChecklist): string => r.id)).toEqual(['ops-reviewer']);   // Z
    });

    /**
     * "Review once" is per subagent, so a FAILED verdict still owes review and stays in Z — AND so does one
     * whose `override` nobody authorized. That second half is the authorization gate seen from the scan: an
     * override written by the reviewer subagent is the agent authorizing itself, and it buys nothing until a
     * human has run `pnpm wp-authorize`.
     */
    it('an un-overridden FAIL owes review — and so does an override NO HUMAN authorized', () => {
        const dir = repoWithFour();
        const svc = new ReviewJsonService();
        const reviewPath = svc.reviewJsonPath(dir, newAiBranchName().getFeatureName());
        fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
        fs.writeFileSync(svc.checklistResultPath(reviewPath, 'db-reviewer'),
            JSON.stringify({ id: 'db-reviewer', status: 'red', output: 'bad', override: '' }));
        fs.writeFileSync(svc.checklistResultPath(reviewPath, 'ops-reviewer'),
            JSON.stringify({ id: 'ops-reviewer', status: 'red', output: 'bad', override: 'accepted, JIRA-1' }));
        const scan = scannerFor().scan(dir, FOUR, SALT, new ChecklistScanOptions(true));
        expect(scan.outstanding.map((r: RequiredChecklist): string => r.id)).toEqual(['db-reviewer', 'ops-reviewer']);
    });

    // …and it stops owing review the moment a signed human approval covering it verifies. Same fixture, one
    // difference: a real `wp-authorize` record, minted through the service the command uses.
    it('an OVERRIDDEN one clears once a signed human approval verifies', () => {
        const dir = repoWithFour();
        const svc = new ReviewJsonService();
        const feature = newAiBranchName().getFeatureName();
        const reviewPath = svc.reviewJsonPath(dir, feature);
        fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
        fs.writeFileSync(svc.checklistResultPath(reviewPath, 'db-reviewer'),
            JSON.stringify({ id: 'db-reviewer', status: 'red', output: 'bad', override: '' }));
        fs.writeFileSync(svc.checklistResultPath(reviewPath, 'ops-reviewer'),
            JSON.stringify({ id: 'ops-reviewer', status: 'red', output: 'bad', override: 'accepted, JIRA-1' }));
        const auth = new HumanAuthorizationService();
        const base = new DiffBasisResolver(newForkPoint(), new GitStatusParser()).resolve(dir).base;
        auth.append(dir, feature, new HumanApproval(
            'ops-reviewer', '', 'Ops signed off in person; shipping the ops half first.', ['**'], base,
            new Date().toISOString(), new Date(Date.now() + 3600 * 1000).toISOString()), SALT);
        const scan = scannerFor().scan(dir, FOUR, SALT, new ChecklistScanOptions(true));
        expect(scan.outstanding.map((r: RequiredChecklist): string => r.id)).toEqual(['db-reviewer']);
        expect(scan.authorized.proseFor('ops-reviewer')).toContain('in person');
    });

});

// Same fixture, split out to keep each describe inside the method-length limit.
describe('ChecklistScanner — degenerate and always-write cases', () => {
    const FOUR = defs([
        { subagent: 'db-reviewer', patterns: ['**/*.sql'] },
        { subagent: 'ops-reviewer', patterns: ['**/Dockerfile'] },
    ]);

    function repoWithFour(): string {
        const dir = repoOnBranch();
        fs.mkdirSync(path.join(dir, 'db'));
        fs.writeFileSync(path.join(dir, 'db', '001.sql'), 'x\n');
        fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node\n');
        return dir;
    }

    it('a repo with no checklists scans clean rather than erroring', () => {
        const dir = repoOnBranch();
        const scan = scannerFor().scan(dir, defs([]), SALT, new ChecklistScanOptions(true));
        expect(scan.defined).toEqual([]);
        expect(scan.applicable).toEqual([]);
        expect(scan.outstanding).toEqual([]);
    });

    it('always writes pr-context.json, so no reviewer block can lose its diff command', () => {
        const dir = repoWithFour();
        const scan = scannerFor().scan(dir, FOUR, SALT, new ChecklistScanOptions(false));
        expect(fs.existsSync(scan.context.prContextPath)).toBe(true);
        expect(scan.context.baseSha).toBe(scan.forkPoint);
    });

    /**
     * Writing is what you get by DEFAULT; opting out is explicit. A reviewer block that lost its diff
     * command because nobody wrote pr-context.json is a bug this codebase already shipped once, so the
     * opt-out has to be a visible act by a caller that writes it later (stage ②, after materializing) —
     * never an omission.
     */
    it('writes a per-stage snapshot beside pr-context.json, so earlier states survive for debugging', () => {
        const dir = repoWithFour();
        const scan = scannerFor().scan(dir, FOUR, SALT, new ChecklistScanOptions(false, 'stage3-finish'));
        const snapshot = path.join(path.dirname(scan.context.prContextPath), 'stages', 'stage3-finish.json');
        expect(fs.existsSync(snapshot)).toBe(true);
        // The snapshot is a byte-for-byte copy of what pr-context.json said AT THAT STAGE — the point is
        // that a later stage overwriting pr-context.json cannot destroy it.
        expect(fs.readFileSync(snapshot, 'utf8')).toBe(fs.readFileSync(scan.context.prContextPath, 'utf8'));
    });

    it('contextStage:"" skips the write, for the one caller that writes it itself afterwards', () => {
        const dir = repoWithFour();
        const scan = scannerFor().scan(dir, FOUR, SALT, new ChecklistScanOptions(false, ''));
        expect(fs.existsSync(scan.context.prContextPath)).toBe(false);
        // …but the context still names WHERE it will be, so a caller can point at it before it exists.
        expect(scan.context.prContextPath).not.toBe('');
        expect(scan.context.baseSha).toBe(scan.forkPoint);
    });
});

describe('ForkPoint.resolveForkPoint — absolute, and no fetch', () => {
    it('is unchanged when main advances past the branch', () => {
        const dir = repoOnBranch();
        fs.writeFileSync(path.join(dir, 'f.txt'), 'feature\n');
        git(dir, 'git add -A');
        git(dir, 'git commit -qm feat');
        const forkPoint = newForkPoint();
        const before = forkPoint.resolveForkPoint(dir);

        // Advance main via a side branch + `git branch -f`, NOT by committing on main directly: the
        // developer's global core.hooksPath pre-commit hook refuses direct commits to main in EVERY repo,
        // scratch ones included, so committing on main here would fail for reasons unrelated to the test.
        git(dir, 'git checkout -q -b mainadvance main');
        fs.writeFileSync(path.join(dir, 'm.txt'), 'main moved\n');
        git(dir, 'git add -A');
        git(dir, 'git commit -qm mainwork');
        git(dir, 'git branch -f main mainadvance');
        git(dir, 'git checkout -q feature');

        // merge-base is the most recent common ancestor; main's new commit is not on this branch, so
        // advancing main cannot move it. THIS is why wp-review-upsert-pr need not fetch.
        expect(forkPoint.resolveForkPoint(dir)).toBe(before);
    });

    it("returns '' rather than throwing when neither origin/main nor main resolves", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-nomain-'));
        git(dir, 'git init -q -b other');
        git(dir, 'git config user.email t@t.co');
        git(dir, 'git config user.name T');
        fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
        git(dir, 'git add -A');
        git(dir, 'git commit -qm a');
        // wp-review-upsert-pr must ALWAYS succeed, so an unresolvable fork point is a value, never an exception.
        expect(newForkPoint().resolveForkPoint(dir)).toBe('');
    });

    it('a scan with no fork point yields no checklists instead of blowing up', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-nomain2-'));
        git(dir, 'git init -q -b other');
        git(dir, 'git config user.email t@t.co');
        git(dir, 'git config user.name T');
        fs.writeFileSync(path.join(dir, 'a.sql'), 'x\n');
        git(dir, 'git add -A');
        git(dir, 'git commit -qm a');
        const checklists = defs([{ subagent: 'db-reviewer', patterns: ['**/*.sql'] }]);
        const scan = scannerFor().scan(dir, checklists, SALT, new ChecklistScanOptions(false));
        expect(scan.forkPoint).toBe('');
        expect(scan.applicable).toEqual([]);
    });
});

// Shared by the two roster describes below (split only to stay inside the method-length limit): 4 defined,
// of which the .sql and Dockerfile ones fire and the .css / *Api.ts ones are evaluated and skipped.
const ROSTER_FOUR = defs([
    { subagent: 'db-reviewer', patterns: ['**/*.sql'] },
    { subagent: 'ops-reviewer', patterns: ['**/Dockerfile'] },
    { subagent: 'ui-reviewer', patterns: ['**/*.css'] },
    { subagent: 'api-reviewer', patterns: ['**/*Api.ts'] },
]);

function repoForRoster(): string {
    const dir = repoOnBranch();
    fs.mkdirSync(path.join(dir, 'db'));
    fs.writeFileSync(path.join(dir, 'db', '001.sql'), 'x\n');
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node\n');
    return dir;
}

// The verdict-file path the scanner reads, with `dir`'s review dir created.
function verdictPath(dir: string, id: string): string {
    const svc = new ReviewJsonService();
    const reviewPath = svc.reviewJsonPath(dir, newAiBranchName().getFeatureName());
    fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
    return svc.checklistResultPath(reviewPath, id);
}

// The roster is what the PR comment publishes: every defined checklist, matched or not.
describe('ChecklistScanner — roster (all X, matched or not)', () => {
    const FOUR = ROSTER_FOUR;
    const repoWithFour = repoForRoster;

    it('carries an entry for every DEFINED checklist, including the two that matched nothing', () => {
        const scan = scannerFor().scan(repoWithFour(), FOUR, SALT, new ChecklistScanOptions(false));
        expect(scan.roster.entries.map((t: TriggeredChecklist): string => t.def.id))
            .toEqual(['db-reviewer', 'ops-reviewer', 'ui-reviewer', 'api-reviewer']);
        const skipped = scan.roster.entries.filter((t: TriggeredChecklist): boolean => t.matchedFiles.length === 0);
        expect(skipped.map((t: TriggeredChecklist): string => t.def.id)).toEqual(['ui-reviewer', 'api-reviewer']);
    });

    it('counts the changed files considered, so "matched 0 of N" has an honest N', () => {
        const scan = scannerFor().scan(repoWithFour(), FOUR, SALT, new ChecklistScanOptions(false));
        expect(scan.roster.changedFileCount).toBe(2);   // db/001.sql + Dockerfile (untracked, uncommitted)
        expect(scan.roster.baseResolved).toBe(true);
    });

    // The false-all-clear guard. With no fork point NOTHING matches — not even a patternless checklist — so
    // an "all skipped ✅" roll-up would attest to a review that never happened.
    it('flags an unresolvable diff base rather than letting zero matches read as all-clear', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-nobase-'));
        git(dir, 'git init -q -b other');
        git(dir, 'git config user.email t@t.co');
        git(dir, 'git config user.name T');
        fs.writeFileSync(path.join(dir, 'a.sql'), 'x\n');
        git(dir, 'git add -A');
        git(dir, 'git commit -qm a');
        const scan = scannerFor().scan(dir, FOUR, SALT, new ChecklistScanOptions(false));
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
        { subagent: 'db-reviewer', patterns: ['**/*.sql'], required: true },
        { subagent: 'ops-reviewer', patterns: ['**/Dockerfile'], required: false },
    ]);

    it('carries `required` from config through to the matched set', () => {
        const scan = scannerFor().scan(repoForRoster(), MIXED, SALT, new ChecklistScanOptions(false));
        expect(scan.applicable.map((r: RequiredChecklist): boolean => r.required)).toEqual([true, false]);
    });

    it('does NOT owe a verdict for an optional checklist nobody ran — that is the whole point', () => {
        const dir = repoForRoster();
        fs.writeFileSync(verdictPath(dir, 'db-reviewer'),
            JSON.stringify({ id: 'db-reviewer', status: 'green', output: 'ok', override: '' }));
        const scan = scannerFor().scan(dir, MIXED, SALT, new ChecklistScanOptions(true));
        expect(scan.outstanding).toEqual([]);
        // Reported as NOT RUN — never folded into `reviewed`, which would put a ✓ on a review that never happened.
        expect(scan.optionalNotRun.map((r: RequiredChecklist): string => r.id)).toEqual(['ops-reviewer']);
        expect(scan.reviewed.map((r: RequiredChecklist): string => r.id)).toEqual(['db-reviewer']);
    });

    it('STILL owes it once that optional reviewer has run and gone red — running one is not ignoring one', () => {
        const dir = repoForRoster();
        fs.writeFileSync(verdictPath(dir, 'db-reviewer'),
            JSON.stringify({ id: 'db-reviewer', status: 'green', output: 'ok', override: '' }));
        fs.writeFileSync(verdictPath(dir, 'ops-reviewer'),
            JSON.stringify({ id: 'ops-reviewer', status: 'red', output: 'runs as root', override: '' }));
        const scan = scannerFor().scan(dir, MIXED, SALT, new ChecklistScanOptions(true));
        expect(scan.outstanding.map((r: RequiredChecklist): string => r.id)).toEqual(['ops-reviewer']);
        expect(scan.optionalNotRun).toEqual([]);
    });

    it('a REQUIRED checklist with no verdict is still outstanding — the exemption is optional-only', () => {
        const scan = scannerFor().scan(repoForRoster(), MIXED, SALT, new ChecklistScanOptions(true));
        expect(scan.outstanding.map((r: RequiredChecklist): string => r.id)).toEqual(['db-reviewer']);
    });

    // An unreadable verdict file is not "not run": the reviewer left something behind, and it has to be
    // fixed rather than silently forgiven because the checklist happened to be optional.
    it('does not exempt an optional checklist whose verdict file is UNREADABLE', () => {
        const dir = repoForRoster();
        fs.writeFileSync(verdictPath(dir, 'db-reviewer'),
            JSON.stringify({ id: 'db-reviewer', status: 'green', output: 'ok', override: '' }));
        fs.writeFileSync(verdictPath(dir, 'ops-reviewer'),
            JSON.stringify({ id: 'ops-reviewer', success: true, output: 'ok', override: '' }));
        const scan = scannerFor().scan(dir, MIXED, SALT, new ChecklistScanOptions(true));
        expect(scan.formatErrors).toHaveLength(1);
        expect(scan.outstanding.map((r: RequiredChecklist): string => r.id)).toEqual(['ops-reviewer']);
        expect(scan.optionalNotRun).toEqual([]);
    });
});

describe('ChecklistScanner — verdict file formats', () => {
    // A verdict file in the removed `success` format must not masquerade as a missing one, or the AI re-runs
    // a reviewer that already ran instead of correcting four characters of JSON.
    it('reports a legacy `success` verdict file as a format error, and still owes the review', () => {
        const dir = repoForRoster();
        fs.writeFileSync(verdictPath(dir, 'db-reviewer'),
            JSON.stringify({ id: 'db-reviewer', success: true, output: 'ok', override: '' }));
        const scan = scannerFor().scan(dir, ROSTER_FOUR, SALT, new ChecklistScanOptions(true));
        expect(scan.formatErrors).toHaveLength(1);
        expect(scan.formatErrors[0]).toContain('"success"');
        expect(scan.outstanding.map((r: RequiredChecklist): string => r.id).sort())
            .toEqual(['db-reviewer', 'ops-reviewer']);
    });

    it('has no format errors when every verdict uses the tri-state status', () => {
        const dir = repoForRoster();
        fs.writeFileSync(verdictPath(dir, 'db-reviewer'),
            JSON.stringify({ id: 'db-reviewer', status: 'yellow', output: 'no CONCURRENTLY', override: '' }));
        const scan = scannerFor().scan(dir, ROSTER_FOUR, SALT, new ChecklistScanOptions(true));
        expect(scan.formatErrors).toEqual([]);
        // yellow SHIPS — it must not be listed as still owing a verdict.
        expect(scan.outstanding.map((r: RequiredChecklist): string => r.id)).toEqual(['ops-reviewer']);
    });
});

describe('ChecklistScanner — patternless checklists always apply', () => {
    it('a checklist with no patterns is applicable on any change', () => {
        const dir = repoOnBranch();
        const checklists = defs([{ subagent: 'security-reviewer' }]);
        fs.writeFileSync(path.join(dir, 'anything.txt'), 'x\n');
        const scan = scannerFor().scan(dir, checklists, SALT, new ChecklistScanOptions(false));
        expect(scan.applicable).toHaveLength(1);
        // [] matchedPatterns is what makes it render as ALWAYS RUNS rather than claiming a "match".
        expect(scan.applicable[0].matchedPatterns).toEqual([]);
    });

    it('keeps the ChecklistDefinition contract the scanner relies on (id == subagent)', () => {
        const def = new ChecklistDefinition('r', 'r', '.claude/review/r.md', ['**/*.sql'], true);
        expect(def.id).toBe(def.subagent);
    });
});
