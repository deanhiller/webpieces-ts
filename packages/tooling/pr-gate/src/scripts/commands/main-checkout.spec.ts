import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CliExitError } from '@webpieces/rules-config';

import { MainCheckout, StashedFiles } from './main-checkout';
import { UntrackedFiles } from './working-tree-gate';

/**
 * Against REAL git, with a REAL origin, deliberately — same reason as `working-tree-gate.spec.ts`. The
 * defect being fixed is a disagreement between what this code believed a checkout does and what git
 * actually does with an untracked file at a path the destination branch tracks. A stubbed git could only
 * ever confirm the belief that was wrong, and the recovery this prints is a command a human will type,
 * so the spec types it too.
 */

let upstream = '';
let repo = '';

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

function identify(dir: string): void {
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
}

function commit(dir: string, message: string): void {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', message);
}

function branch(): string {
    return git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
}

function stashCount(dir: string): number {
    return git(dir, 'stash', 'list').split('\n').filter((line: string): boolean => line !== '').length;
}

function goToMain(untracked: string[]): StashedFiles {
    return new MainCheckout().goToMain(repo, new UntrackedFiles(untracked));
}

/**
 * Put an untracked copy of a file main TRACKS into the working tree — the exact field shape: a generated
 * artifact, committed on main, regenerated (and so untracked) in a working clone.
 */
function stageCollision(path: string): void {
    write(repo, path, 'my generated copy\n');
}

/** Run the `rm ... && git stash pop` line out of the banner, verbatim, in a shell. */
function runPrescribedCure(rendered: string): void {
    const line = rendered.split('\n')
        .map((each: string): string => each.trim())
        .find((each: string): boolean => each.startsWith('rm '));
    if (line === undefined) throw new Error(`no recovery line in the banner:\n${rendered}`);
    const result = spawnSync('sh', ['-c', line], { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`the prescribed cure failed: ${result.stdout}${result.stderr}`);
    }
}

beforeEach((): void => {
    upstream = mkdtempSync(join(tmpdir(), 'main-checkout-up-'));
    git(upstream, 'init', '-q', '-b', 'main');
    identify(upstream);
    write(upstream, 'README.md', 'base\n');
    write(upstream, 'design.html', 'the committed copy\n');
    write(upstream, 'a generated file.html', 'the committed copy\n');
    commit(upstream, 'base');

    repo = mkdtempSync(join(tmpdir(), 'main-checkout-'));
    rmSync(repo, { recursive: true, force: true });
    const cloned = spawnSync('git', ['clone', '-q', upstream, repo], { encoding: 'utf8' });
    if (cloned.status !== 0) throw new Error(`clone failed: ${cloned.stderr}`);
    identify(repo);

    // The branch a developer is standing on, with the artifacts NOT tracked on it.
    git(repo, 'checkout', '-q', '-b', 'feature');
    git(repo, 'rm', '-q', 'design.html', 'a generated file.html');
    commit(repo, 'drop the generated artifacts');
});

afterEach((): void => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(upstream, { recursive: true, force: true });
});

describe('MainCheckout', (): void => {
    it('a clean tree lands on main, fast-forwards it, and stashes nothing', (): void => {
        write(upstream, 'README.md', 'moved on\n');
        commit(upstream, 'later');

        const stashed = goToMain([]);

        expect(stashed.isEmpty()).toBe(true);
        expect(stashed.render()).toBe('');
        expect(branch()).toBe('main');
        expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('moved on\n');
        expect(stashCount(repo)).toBe(0);
    });

    it('untracked files that do NOT collide are left exactly where they are — no stash', (): void => {
        write(repo, 'notes.txt', 'mine\n');

        const stashed = goToMain(['notes.txt']);

        expect(stashed.isEmpty()).toBe(true);
        expect(branch()).toBe('main');
        expect(readFileSync(join(repo, 'notes.txt'), 'utf8')).toBe('mine\n');
        expect(stashCount(repo)).toBe(0);
    });

    it('a COLLIDING untracked file is stashed, the checkout is retried, and main is reached', (): void => {
        stageCollision('design.html');

        const stashed = goToMain(['design.html']);

        expect(stashed.paths).toEqual(['design.html']);
        expect(branch()).toBe('main');
        expect(stashCount(repo)).toBe(1);
        // main's committed copy is what is in the tree now — that is the whole point of reaching main.
        expect(readFileSync(join(repo, 'design.html'), 'utf8')).toBe('the committed copy\n');
    });

    it('the banner SHOUTS, names every stashed path, and prescribes `git stash pop`', (): void => {
        stageCollision('design.html');
        write(repo, 'notes.txt', 'mine\n');

        const rendered = goToMain(['design.html', 'notes.txt']).render();

        expect(rendered).toContain('UNTRACKED FILES WERE STASHED BECAUSE THEY CONFLICTED');
        expect(rendered).toContain('  design.html\n');
        // `git stash -u` takes every untracked file, not only the one that collided — so the banner has
        // to name every one of them, or the reader hunts for a file it never mentions.
        expect(rendered).toContain('  notes.txt\n');
        expect(rendered).toContain('git stash pop');
        expect(rendered).toContain('AGENT MID-UPGRADE CANNOT ASK FOR HELP.');

        // …and its cure has to survive the mixture. Only design.html is back in the tree (main's copy);
        // notes.txt is not there at all, which is why the recovery line deletes with `rm -f` — a plain
        // `rm` would fail on the missing path and the `&&` would swallow the pop.
        runPrescribedCure(rendered);
        expect(readFileSync(join(repo, 'design.html'), 'utf8')).toBe('my generated copy\n');
        expect(readFileSync(join(repo, 'notes.txt'), 'utf8')).toBe('mine\n');
        expect(stashCount(repo)).toBe(0);
    });

    /**
     * The honest half. A bare `git stash pop` is what everyone reaches for, and in THIS state it refuses:
     * main's committed copy now occupies the path, so git says "already exists, no checkout". The banner
     * says so in advance rather than letting the reader think the stash was lost.
     */
    it('a bare `git stash pop` refuses here — and keeps the stash, exactly as the banner says', (): void => {
        stageCollision('design.html');
        const rendered = goToMain(['design.html']).render();

        const pop = spawnSync('git', ['-C', repo, 'stash', 'pop'], { encoding: 'utf8' });

        expect(pop.status).not.toBe(0);
        expect(`${pop.stdout}${pop.stderr}`).toContain('already exists, no checkout');
        expect(stashCount(repo)).toBe(1);
        expect(rendered).toContain('EXPECT THAT POP TO REFUSE THE FIRST TIME.');
        expect(rendered).toContain('already exists, no checkout');
    });

    /**
     * And the half that must actually work: the command the banner prints, typed verbatim by a shell,
     * hands the file back. A cure that does not resolve the state it is printed for is this repo's
     * standing definition of a defect, so the spec runs it rather than reading it.
     */
    it('the prescribed recovery command RECOVERS the file when run verbatim', (): void => {
        stageCollision('design.html');
        const rendered = goToMain(['design.html']).render();

        runPrescribedCure(rendered);

        expect(readFileSync(join(repo, 'design.html'), 'utf8')).toBe('my generated copy\n');
        expect(stashCount(repo)).toBe(0);
    });

    it('a path with a SPACE survives the banner and its cure still runs verbatim', (): void => {
        stageCollision('a generated file.html');

        const rendered = goToMain(['a generated file.html']).render();

        expect(rendered).toContain('  a generated file.html\n');
        runPrescribedCure(rendered);
        expect(readFileSync(join(repo, 'a generated file.html'), 'utf8')).toBe('my generated copy\n');
        expect(stashCount(repo)).toBe(0);
    });

    /**
     * Every other checkout failure still FAILS — stashing is a reaction to the one refusal git names, not
     * a blanket "try harder". Here there is no main to reach at all.
     */
    it('a checkout that fails for any OTHER reason throws, and stashes nothing', (): void => {
        const orphan = mkdtempSync(join(tmpdir(), 'main-checkout-orphan-'));
        git(orphan, 'init', '-q', '-b', 'feature');
        identify(orphan);
        write(orphan, 'README.md', 'base\n');
        commit(orphan, 'base');
        write(orphan, 'design.html', 'mine\n');

        const call = (): StashedFiles =>
            new MainCheckout().goToMain(orphan, new UntrackedFiles(['design.html']));

        expect(call).toThrowError(CliExitError);
        // The replaced message prescribed nothing at all; this one names the states that reach here.
        expect(call).toThrowError(/merge or rebase is in progress/);
        expect(existsSync(join(orphan, 'design.html'))).toBe(true);
        expect(stashCount(orphan)).toBe(0);

        rmSync(orphan, { recursive: true, force: true });
    });

    it('a refusal to fast-forward main still fails, and SAYS the files were stashed', (): void => {
        // Diverge local main from origin/main, so `pull --ff-only` refuses AFTER the stash has happened.
        git(repo, 'checkout', '-q', 'main');
        write(repo, 'local-only.txt', 'committed on local main\n');
        commit(repo, 'a commit origin never saw');
        git(repo, 'checkout', '-q', 'feature');
        write(upstream, 'README.md', 'and origin moved too\n');
        commit(upstream, 'later');
        stageCollision('design.html');

        expect((): StashedFiles => goToMain(['design.html']))
            .toThrowError(/could not fast-forward[\s\S]*WERE STASHED[\s\S]*design\.html/);
        expect(stashCount(repo)).toBe(1);
    });
});
