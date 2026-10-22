import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { specTempDirs } from '@webpieces/tooling-testkit';

import { CapturedOutput } from '../../__tests__/feature-harness';
import { PrGateContainer } from '../pr-gate-container';
import { MainCheckout } from './main-checkout';
import { UntrackedFiles } from './working-tree-gate';

/**
 * The ONE real-git test for `wp-sync-main`'s checkout (#1381). Every behaviour of the program is held by
 * `main-checkout.spec.ts` against a scripted git; what a scripted git cannot prove is that the recovery
 * command the banner prints — a command a human will type — actually gives the files back with the git
 * that is installed. So this test runs the production DAG with the production `GitProcessClient`, then
 * types the printed cure into a shell. One scenario carries every case the cure has to survive: a
 * colliding file, a non-colliding one that the stash takes too, and a path with a space.
 */

const dirs: string[] = [];

function git(dir: string, ...args: string[]): string {
    const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout;
}

function write(dir: string, relative: string, contents: string): void {
    const full = join(dir, relative);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents, 'utf8');
}

function commit(dir: string, message: string): void {
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message);
}

afterEach((): void => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('MainCheckout against a real git', (): void => {
    it('the printed recovery command restores every stashed file; a bare `git stash pop` refuses first', async (): Promise<void> => {
        const upstream = specTempDirs.make('wp-main-checkout-up-');
        const repo = join(specTempDirs.make('wp-main-checkout-'), 'clone');
        dirs.push(upstream, repo);
        git(upstream, 'init', '-q', '-b', 'main');
        write(upstream, 'README.md', 'base\n');
        write(upstream, 'design.html', 'the committed copy\n');
        write(upstream, 'a generated file.html', 'the committed copy\n');
        commit(upstream, 'base');
        const cloned = spawnSync('git', ['clone', '-q', upstream, repo], { encoding: 'utf8' });
        if (cloned.status !== 0) throw new Error(`clone failed: ${cloned.stderr}`);
        // `git stash` needs an identity, and vitest runs with an isolated HOME that has none.
        git(repo, 'config', 'user.email', 't@t');
        git(repo, 'config', 'user.name', 't');
        git(repo, 'checkout', '-q', '-b', 'feature');
        git(repo, 'rm', '-q', 'design.html', 'a generated file.html');
        commit(repo, 'drop the generated artifacts');
        write(repo, 'design.html', 'my generated copy\n');
        write(repo, 'a generated file.html', 'my generated copy\n');
        write(repo, 'notes.txt', 'mine\n');

        const output = CapturedOutput.start();
        const stashed = await new PrGateContainer().create().get(MainCheckout)
            .goToMain(repo, new UntrackedFiles(['a generated file.html', 'design.html', 'notes.txt']));
        output.stop();

        expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
        expect(readFileSync(join(repo, 'design.html'), 'utf8')).toBe('the committed copy\n');

        const pop = spawnSync('git', ['-C', repo, 'stash', 'pop'], { encoding: 'utf8' });
        expect(pop.status).not.toBe(0);
        expect(`${pop.stdout}${pop.stderr}`).toContain('already exists, no checkout');

        const cure = stashed.render().split('\n').map((l: string): string => l.trim())
            .find((l: string): boolean => l.startsWith('rm '));
        const ran = spawnSync('sh', ['-c', cure ?? 'false'], { cwd: repo, encoding: 'utf8' });
        expect(ran.status).toBe(0);
        expect(readFileSync(join(repo, 'design.html'), 'utf8')).toBe('my generated copy\n');
        expect(readFileSync(join(repo, 'a generated file.html'), 'utf8')).toBe('my generated copy\n');
        expect(readFileSync(join(repo, 'notes.txt'), 'utf8')).toBe('mine\n');
        expect(git(repo, 'stash', 'list').trim()).toBe('');
    });
});
