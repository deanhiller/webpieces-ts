import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CliExitError } from '@webpieces/rules-config';

import { WorkingTreeGate, UntrackedFiles } from './working-tree-gate';

/**
 * Against REAL git, deliberately. The whole defect being fixed lived in the difference between what
 * `git status --porcelain` reports and what a branch switch actually carries, so a stubbed git would
 * only ever confirm the author's own model of git — which is the thing that was wrong.
 */

let repo = '';

function git(...args: string[]): void {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function write(relative: string, contents: string): void {
    const full = join(repo, relative);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents, 'utf8');
}

function commitEverything(): void {
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'base');
}

/** The call under test, as a thunk vitest can assert throwing behaviour on. */
function gateCall(): UntrackedFiles {
    return new WorkingTreeGate().assertNoTrackedChanges(repo);
}

beforeEach((): void => {
    repo = mkdtempSync(join(tmpdir(), 'working-tree-gate-'));
    git('init', '-q');
    write('tracked.txt', 'original\n');
    write('a tracked file.txt', 'original\n');
    commitEverything();
});

afterEach((): void => {
    rmSync(repo, { recursive: true, force: true });
});

describe('WorkingTreeGate', (): void => {
    it('a fully clean tree passes and reports no untracked files', (): void => {
        const untracked = gateCall();
        expect(untracked.isEmpty()).toBe(true);
        expect(untracked.render()).toBe('');
    });

    it('UNTRACKED files ONLY: proceeds, and hands the paths back to be mentioned', (): void => {
        write('generated/design.html', '<html></html>');
        const untracked = gateCall();
        expect(untracked.paths).toEqual(['generated/design.html']);
        expect(untracked.render()).toContain('generated/design.html');
        expect(untracked.render()).toContain('leaves them exactly where');
    });

    it('an untracked path containing a SPACE comes back whole, not quoted or split', (): void => {
        write('some dir/a file.html', 'x');
        const untracked = gateCall();
        expect(untracked.paths).toEqual(['some dir/a file.html']);
        expect(untracked.render()).toContain('  some dir/a file.html\n');
    });

    it('a MODIFIED tracked file refuses', (): void => {
        write('tracked.txt', 'changed\n');
        expect(gateCall).toThrowError(CliExitError);
    });

    it('a STAGED change refuses too — index changes ride along just as working-tree ones do', (): void => {
        write('staged.txt', 'new\n');
        git('add', 'staged.txt');
        expect(gateCall).toThrowError(CliExitError);
    });

    it('BOTH tracked and untracked: still refuses, and names only the tracked one', (): void => {
        write('tracked.txt', 'changed\n');
        write('generated/design.html', '<html></html>');
        expect(gateCall).toThrowError(/tracked\.txt/);
        // The untracked file is not the reason for the refusal, so listing it would send the reader
        // chasing a file that has nothing to do with it.
        expect(gateCall).not.toThrowError(/design\.html/);
    });

    /**
     * The point of the whole change: the printed cure must resolve the state it is printed for. A plain
     * `git stash` does NOT take untracked files, so the old message ("stash them", printed for an
     * untracked file) sent the user round the loop unchanged.
     */
    it('the refusal prescribes `git stash`, and `git stash` actually clears it', (): void => {
        write('tracked.txt', 'changed\n');
        expect(gateCall).toThrowError(/git stash/);

        // Run the cure it just prescribed, verbatim — the second call must now pass.
        git('-c', 'user.email=t@t', '-c', 'user.name=t', 'stash');
        expect(gateCall().isEmpty()).toBe(true);
    });

    it('a tracked file whose PATH contains a space is still seen as tracked-dirty', (): void => {
        write('a tracked file.txt', 'changed\n');
        expect(gateCall).toThrowError(CliExitError);
    });

    it('an IGNORED file is not untracked work — .gitignore excludes it from the report', (): void => {
        write('.gitignore', 'noise/\n');
        commitEverything();
        write('noise/whatever.log', 'x');
        expect(gateCall().isEmpty()).toBe(true);
    });
});
