import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CliExitError } from '@webpieces/rules-config';
import { GitResultDto } from '@webpieces/tooling-common';

import { CapturedOutput, PrGateFeature } from '../../__tests__/feature-harness';
import { MainCheckout, StashedFiles } from './main-checkout';
import { UntrackedFiles } from './working-tree-gate';

/**
 * Feature tests for getting onto a current main (#1381): the production `MainCheckout` DAG resolved from
 * the shipped container, with git's answers SCRIPTED. What is asserted is what the program asked git to
 * do and what it said — never a repository on disk.
 *
 * That the printed recovery command really recovers the files with a real git is the one thing a scripted
 * git cannot prove; `main-checkout.real-git.spec.ts` keeps that single integration test.
 */

const REPO = '/repo';
const COLLISION = 'error: The following untracked working tree files would be overwritten by checkout:\n'
    + '\tdesign.html\nPlease move or remove them before you switch branches.\nAborting\n';
const STASH_ARGS = ['-C', REPO, 'stash', 'push', '-u', '-m', 'wp-sync-main: untracked files that collided with main'];

let feature: PrGateFeature;
let output: CapturedOutput;

function scriptHappyPath(): void {
    feature.git.respond(['-C', REPO, 'fetch', 'origin', 'main'], feature.git.ok());
    feature.git.respond(['-C', REPO, 'checkout', 'main'], feature.git.ok('', "Switched to branch 'main'\n"));
    feature.git.respond(['-C', REPO, 'pull', '--ff-only', 'origin', 'main'], feature.git.ok());
}

/** git refuses the first checkout over an untracked file, the stash succeeds, the retry succeeds. */
function scriptCollision(): void {
    feature.git.respond(['-C', REPO, 'fetch', 'origin', 'main'], feature.git.ok());
    feature.git.respond(['-C', REPO, 'checkout', 'main'], feature.git.fail(1, COLLISION));
    feature.git.respond(['-C', REPO, 'checkout', 'main'], feature.git.ok('', "Switched to branch 'main'\n"));
    feature.git.respond(STASH_ARGS, feature.git.ok('Saved working directory and index state\n'));
    feature.git.respond(['-C', REPO, 'pull', '--ff-only', 'origin', 'main'], feature.git.ok());
}

function goToMain(untracked: string[]): Promise<StashedFiles> {
    return feature.container.get(MainCheckout).goToMain(REPO, new UntrackedFiles(untracked));
}

function stashCalls(): number {
    return feature.git.callsStartingWith(['-C', REPO, 'stash']).length;
}

beforeEach(async (): Promise<void> => {
    feature = await PrGateFeature.create();
    output = CapturedOutput.start();
});

afterEach((): void => {
    output.stop();
});

describe('MainCheckout', (): void => {
    it('a clean tree lands on main, fast-forwards it, and stashes nothing', async (): Promise<void> => {
        scriptHappyPath();

        const stashed = await goToMain([]);

        expect(stashed.isEmpty()).toBe(true);
        expect(stashed.render()).toBe('');
        expect(feature.git.commandLines()).toEqual([
            `git -C ${REPO} fetch origin main`,
            `git -C ${REPO} checkout main`,
            `git -C ${REPO} pull --ff-only origin main`,
        ]);
        // fetch and pull render live progress, so they go straight to the terminal; the checkout is piped
        // because its refusal text is what the collision decision reads.
        expect(feature.git.calls.map((c): string => c.mode)).toEqual(['passThrough', 'run', 'passThrough']);
        // The piped checkout is echoed back, so the reader still sees every byte git wrote.
        expect(output.stderr).toContain("Switched to branch 'main'");
    });

    it('untracked files that do NOT collide are left exactly where they are — no stash', async (): Promise<void> => {
        scriptHappyPath();

        const stashed = await goToMain(['notes.txt']);

        expect(stashed.isEmpty()).toBe(true);
        expect(stashCalls()).toBe(0);
    });

    it('a COLLIDING untracked file is stashed, the checkout is retried, and main is reached', async (): Promise<void> => {
        scriptCollision();

        const stashed = await goToMain(['design.html']);

        expect(stashed.paths).toEqual(['design.html']);
        expect(feature.git.commandLines()).toEqual([
            `git -C ${REPO} fetch origin main`,
            `git -C ${REPO} checkout main`,
            `git ${STASH_ARGS.join(' ')}`,
            `git -C ${REPO} checkout main`,
            `git -C ${REPO} pull --ff-only origin main`,
        ]);
        // git's refusal is echoed, not swallowed.
        expect(output.stderr).toContain('would be overwritten by checkout');
    });

    it('the banner SHOUTS, names every stashed path, and prescribes `git stash pop`', async (): Promise<void> => {
        scriptCollision();

        const rendered = (await goToMain(['design.html', 'notes.txt'])).render();

        expect(rendered).toContain('UNTRACKED FILES WERE STASHED BECAUSE THEY CONFLICTED');
        expect(rendered).toContain('  design.html\n');
        // `git stash -u` takes every untracked file, not only the one that collided — so the banner has
        // to name every one of them, or the reader hunts for a file it never mentions.
        expect(rendered).toContain('  notes.txt\n');
        expect(rendered).toContain('git stash pop');
        expect(rendered).toContain('AGENT MID-UPGRADE CANNOT ASK FOR HELP.');
        // The cure deletes with `rm -f`: notes.txt is not in the tree after the checkout, and a plain `rm`
        // would fail on the missing path and the `&&` would swallow the pop.
        expect(rendered).toContain("  rm -f 'design.html' 'notes.txt' && git stash pop\n");
    });

    it('the banner warns that a bare `git stash pop` refuses the first time, and keeps the stash', async (): Promise<void> => {
        scriptCollision();

        const rendered = (await goToMain(['design.html'])).render();

        expect(rendered).toContain('EXPECT THAT POP TO REFUSE THE FIRST TIME.');
        expect(rendered).toContain('already exists, no checkout');
        expect(rendered).toContain('`git stash list` STILL SHOWS THE');
    });

    it('the prescribed recovery command is ONE line that deletes main\'s copy and pops', async (): Promise<void> => {
        scriptCollision();

        const rendered = (await goToMain(['design.html'])).render();

        const cures = rendered.split('\n').map((l: string): string => l.trim()).filter((l: string): boolean => l.startsWith('rm '));
        expect(cures).toEqual(["rm -f 'design.html' && git stash pop"]);
    });

    it('a path with a SPACE survives the banner and its cure quotes it as one argument', async (): Promise<void> => {
        scriptCollision();

        const rendered = (await goToMain(['a generated file.html'])).render();

        expect(rendered).toContain('  a generated file.html\n');
        expect(rendered).toContain("rm -f 'a generated file.html' && git stash pop");
    });

    /**
     * Every other checkout failure still FAILS — stashing is a reaction to the one refusal git names, not
     * a blanket "try harder". Here there is no main to reach at all.
     */
    it('a checkout that fails for any OTHER reason throws, and stashes nothing', async (): Promise<void> => {
        feature.git.respond(['-C', REPO, 'fetch', 'origin', 'main'], feature.git.fail(128, "fatal: couldn't find remote ref main"));
        feature.git.respond(['-C', REPO, 'checkout', 'main'],
            feature.git.fail(1, "error: pathspec 'main' did not match any file(s) known to git\n"));

        const call = goToMain(['design.html']);

        await expect(call).rejects.toBeInstanceOf(CliExitError);
        // The replaced message prescribed nothing at all; this one names the states that reach here.
        await expect(call).rejects.toThrowError(/merge or rebase is in progress/);
        await expect(call).rejects.toThrowError(/pathspec 'main' did not match/);
        expect(stashCalls()).toBe(0);
    });

    it('a refusal to fast-forward main still fails, and SAYS the files were stashed', async (): Promise<void> => {
        // Local main has a commit origin/main does not, so `pull --ff-only` refuses AFTER the stash.
        feature.git.respond(['-C', REPO, 'fetch', 'origin', 'main'], feature.git.ok());
        feature.git.respond(['-C', REPO, 'checkout', 'main'], feature.git.fail(1, COLLISION));
        feature.git.respond(['-C', REPO, 'checkout', 'main'], feature.git.ok());
        feature.git.respond(STASH_ARGS, feature.git.ok());
        feature.git.respond(['-C', REPO, 'pull', '--ff-only', 'origin', 'main'],
            new GitResultDto(128, '', 'fatal: Not possible to fast-forward, aborting.'));

        await expect(goToMain(['design.html']))
            .rejects.toThrowError(/could not fast-forward[\s\S]*WERE STASHED[\s\S]*design\.html/);
        expect(stashCalls()).toBe(1);
        // Nothing was reset — the refusal is a condition for a human, never papered over.
        expect(feature.git.commandLines().some((l: string): boolean => l.includes('reset'))).toBe(false);
    });

    it('a stash that FAILS after the collision refuses, and says nothing was stashed', async (): Promise<void> => {
        feature.git.respond(['-C', REPO, 'fetch', 'origin', 'main'], feature.git.ok());
        feature.git.respond(['-C', REPO, 'checkout', 'main'], feature.git.fail(1, COLLISION));
        feature.git.respond(STASH_ARGS, feature.git.fail(1, 'error: could not write index'));

        await expect(goToMain(['design.html'])).rejects.toThrowError(/NOTHING WAS STASHED/);
        expect(feature.git.callsStartingWith(['-C', REPO, 'checkout']).length).toBe(1);
    });
});
