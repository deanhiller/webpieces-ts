import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { DiffScope } from './diff-scope';
import { FileScope, ProjectIndex, RepoFileLister, WholeScopeModes } from './file-scope';
import { InformAiError } from './inform-ai-error';
import { specTempDirs } from './spec-temp-dirs';

/**
 * The central file-set widening behind the whole-scope modes (#1027): what getChangedFiles and
 * getFileDiff answer inside each FileScope, against a real throwaway git repo.
 */
class Repo {
    readonly root = specTempDirs.makeReal('file-scope-');

    constructor() {
        this.git('init -q -b main');
        this.git('config user.email test@test.com');
        this.git('config user.name test');
        this.project('libs/a', 'alpha');
        this.project('libs/b', 'beta');
        this.write('libs/a/src/One.ts', 'export const one = 1;\n');
        this.write('libs/a/src/Two.ts', 'export const two = 2;\n');
        this.write('libs/a/src/Two.spec.ts', 'export const spec = 0;\n');
        this.write('libs/b/src/Three.ts', 'export const three = 3;\n');
        this.write('tools/orphan.ts', 'export const orphan = 0;\n');
        this.git('add -A');
        this.git('commit -q -m base');
    }

    git(cmd: string): string {
        // core.hooksPath=/dev/null keeps machine-global git hooks out of the throwaway test repo.
        return execSync(`git -c core.hooksPath=/dev/null ${cmd}`, {
            cwd: this.root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
    }

    project(dir: string, name: string): void {
        this.write(`${dir}/project.json`, JSON.stringify({ name }));
    }

    write(relPath: string, content: string): void {
        fs.mkdirSync(path.dirname(path.join(this.root, relPath)), { recursive: true });
        fs.writeFileSync(path.join(this.root, relPath), content);
    }

    changedFilesIn(scope: FileScope): Promise<string[]> {
        const base = this.git('rev-parse HEAD');
        const diffScope = new DiffScope();
        return diffScope.within(scope, async () => diffScope.getChangedFiles(this.root, base).sort());
    }

    dispose(): void {
        fs.rmSync(this.root, { recursive: true, force: true });
    }
}

describe('FileScope — the file set a diff-scoped rule judges', () => {
    let repo: Repo;

    beforeEach(() => {
        repo = new Repo();
        repo.write('libs/a/src/One.ts', 'export const one = 11;\n');
    });

    afterEach(() => {
        repo.dispose();
    });

    it('DIFF (the gate) is exactly the changed files, as before', async () => {
        expect(await repo.changedFilesIn(FileScope.DIFF)).toEqual(['libs/a/src/One.ts']);
    });

    it('MODIFIED_PROJECTS adds every in-scope file of every project the diff touches, and no other project', async () => {
        expect(await repo.changedFilesIn(new FileScope('MODIFIED_PROJECTS', null)))
            .toEqual(['libs/a/src/One.ts', 'libs/a/src/Two.ts']);
    });

    it('MODIFIED_PROJECTS counts a project touched by a non-.ts file too', async () => {
        repo.write('libs/b/README.md', 'touched\n');

        expect(await repo.changedFilesIn(new FileScope('MODIFIED_PROJECTS', null)))
            .toEqual(['libs/a/src/One.ts', 'libs/a/src/Two.ts', 'libs/b/src/Three.ts']);
    });

    it('RUN_EVERY_TIME is every in-scope file in the repo, test files still excluded', async () => {
        expect(await repo.changedFilesIn(new FileScope('RUN_EVERY_TIME', null)))
            .toEqual(['libs/a/src/One.ts', 'libs/a/src/Two.ts', 'libs/b/src/Three.ts', 'tools/orphan.ts']);
    });

    it('a project filter keeps only the named projects\' files, in every kind', async () => {
        expect(await repo.changedFilesIn(new FileScope('RUN_EVERY_TIME', ['libs/b']))).toEqual(['libs/b/src/Three.ts']);
        expect(await repo.changedFilesIn(new FileScope('DIFF', ['libs/b']))).toEqual([]);
    });

    it('a whole scope judges every line: getFileDiff reports the whole file as added, numbered from 1', async () => {
        const base = repo.git('rev-parse HEAD');
        const diffScope = new DiffScope();
        const diff = await diffScope.within(new FileScope('RUN_EVERY_TIME', null), async () =>
            diffScope.getFileDiff(repo.root, 'libs/b/src/Three.ts', base));
        const lines = new DiffScope().getChangedLineNumbers(diff);

        expect(Array.from(lines)).toEqual([1, 2]);
    });

    it('the scope never leaks past the call that set it', async () => {
        await repo.changedFilesIn(new FileScope('RUN_EVERY_TIME', null));

        expect(new DiffScope().currentScope()).toBe(FileScope.DIFF);
    });
});

describe('RepoFileLister', () => {
    it('THROWS when git cannot list the files, rather than widening to nothing and passing', () => {
        const notARepo = specTempDirs.makeReal('file-scope-no-git-');

        expect(() => new RepoFileLister().list(notARepo, ['*.ts'])).toThrow(/could not list the repo's files/);
        fs.rmSync(notARepo, { recursive: true, force: true });
    });
});

describe('ProjectIndex', () => {
    let repo: Repo;

    beforeEach(() => {
        repo = new Repo();
    });

    afterEach(() => {
        repo.dispose();
    });

    it('maps names to roots and files to their owning project', () => {
        const index = new ProjectIndex(repo.root);

        expect(index.rootsFor(['beta', 'alpha'])).toEqual(['libs/b', 'libs/a']);
        expect(index.rootOf('libs/a/src/One.ts')).toBe('libs/a');
        expect(index.rootOf('tools/orphan.ts')).toBeNull();
        expect(index.nameOf('libs/b')).toBe('beta');
    });

    it('refuses an unknown project name, naming the known ones', () => {
        expect(() => new ProjectIndex(repo.root).rootsFor(['gamma'])).toThrow(InformAiError);
        expect(() => new ProjectIndex(repo.root).rootsFor(['gamma'])).toThrow(/'gamma'.*Known projects: alpha, beta/);
    });
});

describe('the mode helpers', () => {
    it('recognises exactly the two whole-scope modes', () => {
        const modes = new WholeScopeModes();

        expect(modes.isWholeScopeMode('MODIFIED_PROJECTS')).toBe(true);
        expect(modes.isWholeScopeMode('RUN_EVERY_TIME')).toBe(true);
        expect(modes.isWholeScopeMode('NEW_AND_MODIFIED_FILES')).toBe(false);
        expect(modes.isWholeScopeMode(undefined)).toBe(false);
    });

    it('picks the most-whole per-file mode, and none for a rule with no diff-scoped mode', () => {
        const modes = new WholeScopeModes();

        expect(modes.wholeFileJudgeMode(['OFF', 'NEW_AND_MODIFIED_CODE', 'NEW_AND_MODIFIED_FILES'])).toBe('NEW_AND_MODIFIED_FILES');
        expect(modes.wholeFileJudgeMode(['OFF', 'NEW_AND_MODIFIED_CODE'])).toBe('NEW_AND_MODIFIED_CODE');
        expect(modes.wholeFileJudgeMode(['OFF', 'MODIFIED_PROJECTS'])).toBeNull();
    });
});
