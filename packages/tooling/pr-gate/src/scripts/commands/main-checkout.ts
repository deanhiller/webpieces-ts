import { spawnSync } from 'child_process';
import { injectable, bindingScopeValues } from 'inversify';
import { CliExitError } from '@webpieces/rules-config';

import { UntrackedFiles } from './working-tree-gate';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * git's own words for the one checkout failure this class is allowed to react to. Matched on git's
 * TEXT rather than re-derived from the untracked list on purpose: git's rules here cover
 * directory-vs-file collisions, sparse checkouts and case-insensitive filesystems, and any
 * re-derivation of them drifts from the git actually installed. git's refusal is the authority.
 */
const WOULD_BE_OVERWRITTEN = 'untracked working tree files would be overwritten';

/** One git invocation's exit status and the output it produced, for a caller that must decide on it. */
export class GitRun {
    constructor(readonly status: number, readonly output: string) {}

    succeeded(): boolean {
        return this.status === 0;
    }
}

/**
 * The files `git stash -u` took so the checkout could proceed — carried out so the caller can SHOUT
 * about them. Empty is the overwhelmingly common case: nothing collided, nothing was stashed.
 *
 * The message is ALL CAPS and banner-wrapped deliberately. This is the one path in the command where
 * files that were sitting in the working tree are no longer sitting in the working tree, and a reader
 * who skims past that line loses track of their own work. Everything else this command prints is
 * routine; this is not.
 */
export class StashedFiles {
    constructor(readonly paths: readonly string[]) {}

    isEmpty(): boolean {
        return this.paths.length === 0;
    }

    /** The human-facing banner, or '' when nothing was stashed. */
    render(): string {
        if (this.isEmpty()) return '';
        const list = this.paths.map((path: string): string => `  ${path}\n`).join('');
        const quoted = this.paths.map((path: string): string => `'${path}'`).join(' ');
        return `${SEP}⚠️  UNTRACKED FILES WERE STASHED BECAUSE THEY CONFLICTED\n${SEP}\n`
            + 'GIT REFUSED TO CHECK OUT MAIN: AN UNTRACKED FILE HERE SITS AT A PATH MAIN TRACKS, AND\n'
            + 'THE CHECKOUT WOULD HAVE OVERWRITTEN IT. `git stash -u` TAKES EVERY UNTRACKED FILE, NOT\n'
            + 'ONLY THE ONE THAT COLLIDED, SO ALL OF THESE LEFT THE WORKING TREE. THE CHECKOUT WAS THEN\n'
            + 'RETRIED AND YOU ARE NOW ON A CLEAN MAIN. NOTHING WAS DELETED — YOUR VERSION OF EVERY\n'
            + 'FILE BELOW IS IN THE STASH:\n\n'
            + list
            + '\nGET THEM BACK WITH:\n\n'
            + '  git stash pop\n\n'
            + 'EXPECT THAT POP TO REFUSE THE FIRST TIME. IT LANDS ON THE NEW MAIN, WHICH IS EXACTLY\n'
            + 'WHERE A COMMITTED COPY OF THE COLLIDING PATH NOW SITS — THAT COLLISION IS WHY ANY OF\n'
            + 'THIS HAPPENED — SO GIT SAYS "already exists, no checkout" AND KEEPS THE STASH. TO TAKE\n'
            + 'YOUR VERSIONS BACK, DELETE MAIN\'S COPIES AND POP ONTO THE HOLE:\n\n'
            + `  rm -f ${quoted} && git stash pop\n\n`
            + 'NOTHING IS DISCARDED WHILE THE POP HAS NOT SUCCEEDED — `git stash list` STILL SHOWS THE\n'
            + 'ENTRY, AS MANY TRIES AS YOU NEED. IF THE FILE IS GENERATED, REGENERATING IT ON THE NEW\n'
            + 'MAIN IS USUALLY BETTER THAN RESTORING A COPY BUILT FROM THE OLD ONE.\n\n'
            + 'WHY STASHED AND NOT REFUSED: REACHING A CLEAN MAIN HAS TO STAY POSSIBLE. A REFUSAL HERE\n'
            + 'DEADLOCKS ANYONE — HUMAN OR AGENT — WHOSE NEXT STEP IS GATED ON BEING ON MAIN, AND AN\n'
            + `AGENT MID-UPGRADE CANNOT ASK FOR HELP.\n${SEP}`;
    }
}

/**
 * Get onto a current main, whatever the working tree is holding.
 *
 * ─── WHY A COLLISION STASHES RATHER THAN REFUSES ──────────────────────────────────────────────────
 * `WorkingTreeGate` deliberately lets untracked files through: they are on no branch, so the switch
 * does not move them. That is true about the FILES and not true about the CHECKOUT — git aborts when
 * an untracked file sits at a path the destination branch TRACKS ("The following untracked working
 * tree files would be overwritten by checkout"). Letting untracked files reach the checkout is
 * exactly what makes that abort reachable, and the field case that produced it is the common one: a
 * generated `design.html`, untracked in a working clone because it is regenerated, and committed on
 * main.
 *
 * A refusal there is a DEAD END for the one caller that most needs the command to work — an agent
 * mid-upgrade of webpieces, unable to use its tools until it reaches a clean main, with nobody
 * watching to move the file for it. So the collision is resolved rather than reported: stash with
 * `-u`, retry, and then say so loudly enough that no human loses track of the files. Losing a minute
 * to a `git stash pop` beats a state nothing can get out of.
 *
 * ─── WHY THE CHECKOUT'S OUTPUT IS CAPTURED AND RE-PRINTED ─────────────────────────────────────────
 * The decision above is made on git's own refusal text, which means the checkout cannot run on
 * `stdio: 'inherit'` — inherited output is never seen by this process. It is piped and echoed back
 * instead, so the reader still gets every byte git wrote. `fetch` and `pull` stay inherited: nothing
 * is decided from their text, and they are the two that render live progress, which a pipe flattens.
 */
@injectable(bindingScopeValues.Singleton)
export class MainCheckout {
    /**
     * Fetch, check out main, fast-forward it. Returns the files that had to be stashed to get there —
     * empty in the ordinary case.
     *
     * `--ff-only` rather than a `reset --hard`, deliberately: a developer or an agent that
     * accidentally committed to local main would have that work silently destroyed by a reset, and
     * the whole point of this command is that it is safe to run without thinking. A refusal to
     * fast-forward is a real condition a human should see and decide about.
     */
    goToMain(repoRoot: string, untracked: UntrackedFiles): StashedFiles {
        this.passThrough(repoRoot, ['fetch', 'origin', 'main']);
        const stashed = this.checkoutMain(repoRoot, untracked);
        if (this.passThrough(repoRoot, ['pull', '--ff-only', 'origin', 'main']) !== 0) {
            throw new CliExitError(1, `${SEP}❌ Local main could not fast-forward\n${SEP}\n`
                + 'Local main has commits that origin/main does not, so it is not a clean copy of the\n'
                + 'remote. Nothing was reset — those commits may be the only copy. Inspect them with\n'
                + '`git log origin/main..main` and decide what they are before going further.\n'
                + this.alsoStashed(stashed));
        }
        return stashed;
    }

    private checkoutMain(repoRoot: string, untracked: UntrackedFiles): StashedFiles {
        const first = this.captureAndEcho(repoRoot, ['checkout', 'main']);
        if (first.succeeded()) return new StashedFiles([]);
        if (!this.isCollision(first, untracked)) throw this.checkoutFailed(first);

        const stash = this.captureAndEcho(repoRoot, ['stash', 'push', '-u',
            '-m', 'wp-sync-main: untracked files that collided with main']);
        if (!stash.succeeded()) {
            throw new CliExitError(1, `${SEP}❌ Could not check out main, and could not stash\n${SEP}\n`
                + 'git refused the checkout because untracked files in this tree sit at paths main\n'
                + 'tracks, and `git stash -u` then failed too, so NOTHING WAS STASHED — the tree is\n'
                + 'exactly as you left it and you are still on your branch. Both git messages are\n'
                + 'above. Move or delete these files yourself, then re-run:\n\n'
                + this.list(untracked.paths));
        }

        const second = this.captureAndEcho(repoRoot, ['checkout', 'main']);
        const stashed = new StashedFiles(untracked.paths);
        if (!second.succeeded()) {
            throw new CliExitError(1, `${SEP}❌ Could not check out main even after stashing\n${SEP}\n`
                + 'The untracked files below WERE stashed — they are no longer in the working tree —\n'
                + 'and git still refused the checkout, so something else is blocking it. Its message is\n'
                + 'above. You are still on your branch. Recover the files with `git stash pop`, and\n'
                + 'read git\'s reason before re-running:\n\n'
                + this.list(stashed.paths));
        }
        return stashed;
    }

    /**
     * Only the collision git NAMES, and only when there is something a stash could actually take.
     * Untracked files with any other refusal, or a refusal with an empty untracked list, is a
     * different problem and stashing would be a guess.
     */
    private isCollision(run: GitRun, untracked: UntrackedFiles): boolean {
        return run.output.includes(WOULD_BE_OVERWRITTEN) && !untracked.isEmpty();
    }

    private checkoutFailed(run: GitRun): CliExitError {
        return new CliExitError(1, `${SEP}❌ Could not check out main\n${SEP}\n`
            + 'git refused the checkout for a reason this command does not resolve on your behalf — its\n'
            + 'message is above and is the thing to read. The states that reach here:\n\n'
            + '  • a merge or rebase is in progress — finish it or `git merge --abort` / `git rebase\n'
            + '    --abort`, then re-run\n'
            + '  • unmerged paths from a conflict — resolve them and `git add` them, then re-run\n'
            + '  • no local `main` and no `origin/main` to create it from — check `git remote -v`\n\n'
            + `git's output:\n${run.output}`);
    }

    /** Appended to a failure that happens AFTER the stash, so the stash is never silently forgotten. */
    private alsoStashed(stashed: StashedFiles): string {
        if (stashed.isEmpty()) return '';
        return '\nALSO: THESE UNTRACKED FILES WERE STASHED TO GET HERE — `git stash pop` RETURNS THEM:\n\n'
            + this.list(stashed.paths);
    }

    private list(paths: readonly string[]): string {
        return paths.map((path: string): string => `  ${path}\n`).join('');
    }

    /** git piped, then echoed back verbatim — for the one command whose text is decided on. */
    private captureAndEcho(repoRoot: string, args: string[]): GitRun {
        const result = spawnSync('git', ['-C', repoRoot, ...args], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
        const stdout = result.stdout ?? '';
        const stderr = result.stderr ?? '';
        process.stdout.write(stdout);
        process.stderr.write(stderr);
        return new GitRun(result.status === null ? 1 : result.status, `${stdout}${stderr}`);
    }

    /** git with its output going straight to the terminal — for the commands whose progress is the point. */
    private passThrough(repoRoot: string, args: string[]): number {
        const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: 'inherit' });
        return result.status === null ? 1 : result.status;
    }
}
