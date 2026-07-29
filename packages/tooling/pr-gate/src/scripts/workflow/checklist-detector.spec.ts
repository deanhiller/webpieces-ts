import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChecklistDefinition, DiffScope } from '@webpieces/rules-config';
import { ChecklistDetector } from './checklist-detector';

const detector = new ChecklistDetector(new DiffScope());

// id = subagent name; doc + patterns configurable.
function def(subagent = 'migrations-reviewer', patterns: string[] = ['**/*.sql']): ChecklistDefinition {
    return new ChecklistDefinition(subagent, subagent, `.claude/review/${subagent}.md`, patterns);
}

describe('ChecklistDetector.detect', () => {
    it('matches a checklist on a changed file hitting its patterns', () => {
        const triggered = detector.detect([def()], ['db/001.sql', 'src/a.ts']);
        expect(triggered).toHaveLength(1);
        expect(triggered[0].matchedFiles).toEqual(['db/001.sql']);
    });

    it('does not match when no changed file hits the patterns', () => {
        expect(detector.detect([def()], ['src/a.ts', 'README.md'])).toEqual([]);
    });

    it('empty patterns match EVERY changed file (always runs)', () => {
        const d = def('always-reviewer', []);
        const triggered = detector.detect([d], ['src/a.ts', 'README.md']);
        expect(triggered).toHaveLength(1);
        expect(triggered[0].matchedFiles).toEqual(['src/a.ts', 'README.md']);
    });

    it('is extension-agnostic — non-.ts files match (the tsOnly trap is in detectForRange)', () => {
        const d = def('deploy-reviewer', ['**/Dockerfile', '**/*.sql', '.env*']);
        const triggered = detector.detect([d], ['ops/Dockerfile', '.env.prod']);
        expect(triggered).toHaveLength(1);
        expect(triggered[0].matchedFiles).toEqual(['ops/Dockerfile', '.env.prod']);
    });

    it('toRequired maps every matched checklist to the RequiredChecklist shape', () => {
        const required = detector.toRequired(detector.detect([def()], ['db/001.sql']));
        expect(required).toHaveLength(1);
        expect(required[0].id).toBe('migrations-reviewer');
        expect(required[0].subagent).toBe('migrations-reviewer');
        expect(required[0].doc).toBe('.claude/review/migrations-reviewer.md');
        expect(required[0].matchedFiles).toEqual(['db/001.sql']);
    });
});

// One end-to-end pass over a real git repo — proves detectForRepo passes tsOnly:false, so a *.sql file is
// seen at all (the default would silently drop it and report "no checklists matched").
function git(cwd: string, cmd: string): void {
    execSync(cmd, { cwd, stdio: 'pipe' });
}

describe('ChecklistDetector.detectForRepo (git integration)', () => {
    it('sees non-.ts changes (tsOnly:false) and matches by path', () => {
        delete process.env['NX_BASE'];
        delete process.env['NX_HEAD'];
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-detect-'));
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
        git(repo, 'git add -A');
        git(repo, 'git commit -q -m feature');

        const triggered = detector.detectForRepo(repo, [def()]);
        expect(triggered.map((t): string => t.def.id)).toEqual(['migrations-reviewer']);
        expect(triggered[0].matchedFiles).toEqual(['db/001.sql']);
    });
});
