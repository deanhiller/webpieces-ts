import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChecklistDefinition, DiffScope } from '@webpieces/rules-config';
import { ChecklistDetector } from './checklist-detector';

const detector = new ChecklistDetector(new DiffScope());

function def(overrides: Partial<ChecklistDefinition> = {}): ChecklistDefinition {
    const base = new ChecklistDefinition('migrations', 'DB migrations', ['**/*.sql'], [], ['.claude/m.md'], 'BLOCK', 'Walk it.', false);
    return Object.assign(base, overrides);
}

function added(entries: Record<string, string[]>): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const file of Object.keys(entries)) map.set(file, entries[file]);
    return map;
}

describe('ChecklistDetector.detect', () => {
    it('fires a path-only checklist on a matching changed file', () => {
        const triggered = detector.detect([def()], ['db/001.sql', 'src/a.ts'], added({}));
        expect(triggered).toHaveLength(1);
        expect(triggered[0].matchedFiles).toEqual(['db/001.sql']);
        expect(triggered[0].matchedContent).toEqual([]);
    });

    it('does not fire when no changed file matches the path patterns', () => {
        expect(detector.detect([def()], ['src/a.ts', 'README.md'], added({}))).toEqual([]);
    });

    it('fires a content-only checklist (patterns:[] = any file) on a matching added line', () => {
        const d = def({ patterns: [], contentPatterns: ['@Post\\('] });
        const triggered = detector.detect([d], ['src/ctrl.ts'], added({ 'src/ctrl.ts': ['const x = 1;', '  @Post()'] }));
        expect(triggered).toHaveLength(1);
        expect(triggered[0].matchedFiles).toEqual(['src/ctrl.ts']);
        expect(triggered[0].matchedContent).toEqual(['  @Post()']);
    });

    it('requires BOTH path and content when contentPatterns is set (path match alone is not enough)', () => {
        const d = def({ patterns: ['src/**'], contentPatterns: ['CloudTasksClient'] });
        // Path matches but no added line matches the content → no trigger.
        expect(detector.detect([d], ['src/a.ts'], added({ 'src/a.ts': ['nothing here'] }))).toEqual([]);
        // Path matches AND an added line matches → trigger.
        const hit = detector.detect([d], ['src/a.ts'], added({ 'src/a.ts': ['new CloudTasksClient()'] }));
        expect(hit).toHaveLength(1);
        expect(hit[0].matchedContent).toEqual(['new CloudTasksClient()']);
    });

    it('skips a disabled checklist entirely', () => {
        expect(detector.detect([def({ disabled: true })], ['db/001.sql'], added({}))).toEqual([]);
    });

    it('is extension-agnostic — a non-.ts file triggers a path checklist (the tsOnly trap is in detectForRepo)', () => {
        const d = def({ patterns: ['**/Dockerfile', '**/*.sql', '.env*'] });
        const triggered = detector.detect([d], ['ops/Dockerfile', '.env.prod'], added({}));
        expect(triggered).toHaveLength(1);
        expect(triggered[0].matchedFiles).toEqual(['ops/Dockerfile', '.env.prod']);
    });

    it('toRequired maps every triggered checklist to the RequiredChecklist shape', () => {
        const triggered = detector.detect([def()], ['db/001.sql'], added({}));
        const required = detector.toRequired(triggered);
        expect(required).toHaveLength(1);
        expect(required[0].id).toBe('migrations');
        expect(required[0].severity).toBe('BLOCK');
        expect(required[0].docs).toEqual(['.claude/m.md']);
        expect(required[0].matchedFiles).toEqual(['db/001.sql']);
    });
});

// One end-to-end pass over a real git repo — proves detectForRepo passes tsOnly:false (so a *.sql file
// is seen at all) and that content matching strips the `+`/ignores the `+++` diff header.
function git(cwd: string, cmd: string): void {
    execSync(cmd, { cwd, stdio: 'pipe' });
}

describe('ChecklistDetector.detectForRepo (git integration)', () => {
    it('sees non-.ts changes and matches added content without matching the +++ header', () => {
        delete process.env['NX_BASE'];
        delete process.env['NX_HEAD'];
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-detect-'));
        // core.hooksPath /dev/null so the machine's global git hooks can't block commits to main.
        git(repo, 'git init -b main -q');
        git(repo, 'git config core.hooksPath /dev/null');
        git(repo, 'git config user.email t@t.co');
        git(repo, 'git config user.name t');
        fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
        git(repo, 'git add -A');
        git(repo, 'git commit -q -m base');
        git(repo, 'git checkout -q -b feature');

        fs.mkdirSync(path.join(repo, 'db'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'db', '001.sql'), 'CREATE TABLE t (id int);\n');
        fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'src', 'ctrl.ts'), '@Post()\nexport class C {}\n');
        git(repo, 'git add -A');
        git(repo, 'git commit -q -m feature');

        const sqlDef = new ChecklistDefinition('migrations', 'DB migrations', ['**/*.sql'], [], ['.claude/m.md'], 'BLOCK', 'Walk it.', false);
        // contentPattern 'ctrl' would falsely match the `+++ b/src/ctrl.ts` header if headers weren't dropped.
        const postDef = new ChecklistDefinition('endpoints', 'New endpoints', ['**/*.ts'], ['@Post\\(', 'ctrl'], ['.claude/e.md'], 'WARN', '', false);

        const triggered = detector.detectForRepo(repo, [sqlDef, postDef]);
        const byId = new Map(triggered.map((t): [string, typeof t] => [t.def.id, t]));

        expect(byId.has('migrations')).toBe(true);
        expect(byId.get('migrations')!.matchedFiles).toEqual(['db/001.sql']);

        expect(byId.has('endpoints')).toBe(true);
        // Only the real added line matched — NOT the `+++ b/src/ctrl.ts` header (which contains "ctrl").
        expect(byId.get('endpoints')!.matchedContent).toEqual(['@Post()']);
    });
});
