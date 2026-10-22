import * as fs from 'fs';
import * as path from 'path';

/**
 * A git checkout laid out on disk exactly as git lays it out — WITHOUT running git (#1381). Every webpieces
 * reader of "where is this checkout" (GitCheckout, DotWebpieces, RepoRootFinder) reads these files and
 * starts no process, so a spec about state or log PLACEMENT needs only the layout:
 *
 *   primary/.git/{HEAD, objects/}                                   the primary clone, on `main`
 *   primary/.git/worktrees/<name>/{HEAD, commondir, gitdir}         git's record of a linked worktree
 *   <worktree>/.git                                                 `gitdir: <primary>/.git/worktrees/<name>`
 *
 * That the installed git really lays a checkout out this way is proven once, against real git, by the
 * `git-checkout` and `worktree-identity` contract specs in rules-config.
 */
export class CheckoutLayout {
    /** A primary clone on `branch` — what `git init -b <branch>` leaves. */
    static primary(primary: string, branch: string): void {
        const gitDir = path.join(primary, '.git');
        fs.mkdirSync(path.join(gitDir, 'objects'), { recursive: true });
        fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true });
        fs.writeFileSync(path.join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`);
    }

    /** A primary clone on `main` with ONE linked worktree on `branch`. */
    static primaryWithWorktree(primary: string, worktree: string, branch: string): void {
        CheckoutLayout.primary(primary, 'main');
        CheckoutLayout.linkedWorktree(primary, worktree, branch);
    }

    /** One more linked worktree of an existing primary clone — what `git worktree add` records. */
    static linkedWorktree(primary: string, worktree: string, branch: string): void {
        const record = CheckoutLayout.record(primary, worktree);
        fs.mkdirSync(record, { recursive: true });
        fs.writeFileSync(path.join(record, 'HEAD'), `ref: refs/heads/${branch}\n`);
        fs.writeFileSync(path.join(record, 'commondir'), '../..\n');
        fs.writeFileSync(path.join(record, 'gitdir'), `${path.join(worktree, '.git')}\n`);
        fs.mkdirSync(worktree, { recursive: true });
        fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${record}\n`);
    }

    /** What `git worktree remove --force` leaves: neither the directory nor git's record of it. */
    static removeLinkedWorktree(primary: string, worktree: string): void {
        fs.rmSync(CheckoutLayout.record(primary, worktree), { recursive: true, force: true });
        fs.rmSync(worktree, { recursive: true, force: true });
    }

    /**
     * Point a checkout's HEAD at `branch` (what `git checkout -b <branch>` leaves) — `checkout` is the
     * primary clone or a linked worktree; either way its HEAD file is the one git would rewrite.
     */
    static checkoutBranch(checkout: string, branch: string): void {
        fs.writeFileSync(CheckoutLayout.headFile(checkout), `ref: refs/heads/${branch}\n`);
    }

    /** Detach a checkout's HEAD at `sha` — what `git checkout --detach` leaves. */
    static detach(checkout: string, sha: string): void {
        fs.writeFileSync(CheckoutLayout.headFile(checkout), `${sha}\n`);
    }

    // The HEAD file of a primary clone (`.git/HEAD`) or of a linked worktree (its record's HEAD).
    private static headFile(checkout: string): string {
        const dotGit = path.join(checkout, '.git');
        if (fs.statSync(dotGit).isDirectory()) return path.join(dotGit, 'HEAD');
        const pointer = fs.readFileSync(dotGit, 'utf8').trim().replace(/^gitdir:\s*/, '');
        return path.join(pointer, 'HEAD');
    }

    private static record(primary: string, worktree: string): string {
        return path.join(primary, '.git', 'worktrees', path.basename(worktree));
    }
}
