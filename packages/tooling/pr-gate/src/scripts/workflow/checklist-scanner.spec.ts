import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChecklistDefinition, DiffScope, RequiredChecklist, ReviewJsonService, toChecklist } from '@webpieces/rules-config';
import { ChecklistDetector } from './checklist-detector';
import { ChecklistScanner, ChecklistScanOptions } from './checklist-scanner';
import { ForkPoint } from './git-findForkPoint';
import { PrContextWriter } from './pr-context-writer';
import { AiBranchName } from './git-readAiBranchName';
import { BranchNaming } from './branch-naming';

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

/**
 * The already-validated `prGate.checklists` a command would hand the scanner. Built through the real
 * `toChecklist` narrowing so the fixture cannot drift from how config entries actually become definitions.
 */
function defs(items: readonly { subagent?: string; doc?: string; patterns?: string[] }[]): ChecklistDefinition[] {
    return items.map((i: { subagent?: string; doc?: string; patterns?: string[] }): ChecklistDefinition => toChecklist(i));
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
    return new ChecklistScanner(
        newAiBranchName(), new ChecklistDetector(diffScope), diffScope, newForkPoint(),
        new PrContextWriter(diffScope, reviewJson), reviewJson,
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
        const scan = scannerFor().scan(dir, checklists, new ChecklistScanOptions(false));
        expect(scan.applicable.map((r: RequiredChecklist): string => r.id)).toEqual(['db-reviewer']);
    });

    it('matches a checklist on an UNTRACKED file', () => {
        const dir = repoOnBranch();
        const checklists = defs([{ subagent: 'db-reviewer', patterns: ['**/*.sql'] }]);
        fs.mkdirSync(path.join(dir, 'db'));
        fs.writeFileSync(path.join(dir, 'db', '002.sql'), 'CREATE TABLE b();\n'); // never `git add`ed
        const scan = scannerFor().scan(dir, checklists, new ChecklistScanOptions(false));
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
        const scan = scannerFor().scan(dir, checklists, new ChecklistScanOptions(false));
        expect(scan.applicable.map((r: RequiredChecklist): string => r.id)).toEqual(['db-reviewer']);
    });

    // tsOnly defaults to true in DiffScope and would drop .sql / Dockerfile / .env* — the files a checklist
    // most wants to key on. The scanner must override it.
    it('sees non-.ts files (tsOnly:false)', () => {
        const dir = repoOnBranch();
        const checklists = defs([{ subagent: 'ops-reviewer', patterns: ['**/Dockerfile', '**/.env*'] }]);
        fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node\n');
        expect(scannerFor().scan(dir, checklists, new ChecklistScanOptions(false)).applicable).toHaveLength(1);
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
        const scan = scannerFor().scan(repoWithFour(), FOUR, new ChecklistScanOptions(false));
        expect(scan.defined).toHaveLength(4);
        expect(scan.applicable.map((r: RequiredChecklist): string => r.id).sort()).toEqual(['db-reviewer', 'ops-reviewer']);
    });

    it('filterAlreadyReviewed:false leaves outstanding == applicable, so wp-checklist LISTS them all', () => {
        const scan = scannerFor().scan(repoWithFour(), FOUR, new ChecklistScanOptions(false));
        expect(scan.outstanding).toHaveLength(2);
        expect(scan.reviewed).toHaveLength(0);
    });

    it('filterAlreadyReviewed:true narrows N to Z — only what still owes a verdict', () => {
        const dir = repoWithFour();
        const svc = new ReviewJsonService();
        const reviewPath = svc.reviewJsonPath(dir, newAiBranchName().getFeatureName());
        fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
        fs.writeFileSync(svc.checklistResultPath(reviewPath, 'db-reviewer'),
            JSON.stringify({ id: 'db-reviewer', success: true, output: 'ok', override: '' }));
        const scan = scannerFor().scan(dir, FOUR, new ChecklistScanOptions(true));
        expect(scan.applicable).toHaveLength(2);                                                         // N
        expect(scan.reviewed.map((r: RequiredChecklist): string => r.id)).toEqual(['db-reviewer']);
        expect(scan.outstanding.map((r: RequiredChecklist): string => r.id)).toEqual(['ops-reviewer']);   // Z
    });

    // "Review once" is per subagent: 2 of 4 done means the other 2 still need running, so a FAILED verdict
    // with no override still owes review and must stay in Z.
    it('an un-overridden FAIL still owes review; an OVERRIDDEN one does not', () => {
        const dir = repoWithFour();
        const svc = new ReviewJsonService();
        const reviewPath = svc.reviewJsonPath(dir, newAiBranchName().getFeatureName());
        fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
        fs.writeFileSync(svc.checklistResultPath(reviewPath, 'db-reviewer'),
            JSON.stringify({ id: 'db-reviewer', success: false, output: 'bad', override: '' }));
        fs.writeFileSync(svc.checklistResultPath(reviewPath, 'ops-reviewer'),
            JSON.stringify({ id: 'ops-reviewer', success: false, output: 'bad', override: 'accepted, JIRA-1' }));
        const scan = scannerFor().scan(dir, FOUR, new ChecklistScanOptions(true));
        expect(scan.outstanding.map((r: RequiredChecklist): string => r.id)).toEqual(['db-reviewer']);
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
        const scan = scannerFor().scan(dir, defs([]), new ChecklistScanOptions(true));
        expect(scan.defined).toEqual([]);
        expect(scan.applicable).toEqual([]);
        expect(scan.outstanding).toEqual([]);
    });

    it('always writes pr-context.json, so no reviewer block can lose its diff command', () => {
        const dir = repoWithFour();
        const scan = scannerFor().scan(dir, FOUR, new ChecklistScanOptions(false));
        expect(fs.existsSync(scan.context.prContextPath)).toBe(true);
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
        // advancing main cannot move it. THIS is why wp-checklist need not fetch.
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
        // wp-checklist must ALWAYS succeed, so an unresolvable fork point is a value, never an exception.
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
        const scan = scannerFor().scan(dir, checklists, new ChecklistScanOptions(false));
        expect(scan.forkPoint).toBe('');
        expect(scan.applicable).toEqual([]);
    });
});

describe('ChecklistScanner — patternless checklists always apply', () => {
    it('a checklist with no patterns is applicable on any change', () => {
        const dir = repoOnBranch();
        const checklists = defs([{ subagent: 'security-reviewer' }]);
        fs.writeFileSync(path.join(dir, 'anything.txt'), 'x\n');
        const scan = scannerFor().scan(dir, checklists, new ChecklistScanOptions(false));
        expect(scan.applicable).toHaveLength(1);
        // [] matchedPatterns is what makes it render as ALWAYS RUNS rather than claiming a "match".
        expect(scan.applicable[0].matchedPatterns).toEqual([]);
    });

    it('keeps the ChecklistDefinition contract the scanner relies on (id == subagent)', () => {
        const def = new ChecklistDefinition('r', 'r', '.claude/review/r.md', ['**/*.sql']);
        expect(def.id).toBe(def.subagent);
    });
});
