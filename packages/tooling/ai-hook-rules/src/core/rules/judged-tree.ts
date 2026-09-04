import { atRoot } from '@webpieces/rules-config';

import { EffectiveTree } from '../effective-tree';

/**
 * The tree a file-scoped branch-state guard actually judged, plus the two things a deny must say about
 * it: WHICH branch in WHICH tree, and — when that is not the tree the agent is standing in — how to aim
 * the cure at it.
 *
 * BOTH halves come from one live incident (issue #851), and the second is why the first is not enough.
 *
 * 1. NAME THE TREE. The deny read *"origin/main moved and touched files you also changed since your
 *    fork point"* and then listed `pnpm-lock.yaml` and `pnpm-workspace.yaml` — files the edit had never
 *    touched, on a branch it was not on. With no branch and no tree in the text there was nothing to
 *    contradict, so the misfire looked like an ordinary block for four tool calls. A wrong resolution
 *    must be VISIBLE; that is the cheapest defence there is against the next one.
 *
 * 2. AIM THE CURE. `pnpm wp-start-update` acts on the tree it RUNS IN. When the judged tree is not the
 *    cwd, the cure as printed is a guaranteed no-op — measured: it ran, reported "Updated from main —
 *    clean", and the identical edit was blocked 20 seconds later against a cache recomputed 8 seconds
 *    AFTER the cure. The command was correct and the directory was not, and nothing on screen said so.
 *    `pnpm --dir=<tree>` is the same command with the missing half supplied.
 *
 * The redirect note is printed ONLY when the two trees actually differ. In the primary clone — the
 * overwhelmingly common case — the header alone is all a reader gets, because a `--dir` that names the
 * directory you are already in is noise that trains people to skip the paragraph.
 */
export class JudgedTree {
    /** The tree root whose HEAD and main-sync entry decided this verdict. */
    readonly root: string;
    /** That tree's branch — the key the branch-keyed main-sync cache was read under. */
    readonly branch: string;
    /** The tree the agent's own session is rooted in — where an unqualified `pnpm …` would run. */
    readonly sessionRoot: string;

    constructor(tree: EffectiveTree, branch: string, sessionRoot: string) {
        this.root = tree.root;
        this.branch = branch;
        this.sessionRoot = sessionRoot;
    }

    /** True when the file being judged belongs to a DIFFERENT checkout than the session's own. */
    get redirected(): boolean {
        return this.root !== this.sessionRoot;
    }

    /** The one line every deny from these guards opens with. */
    header(): string {
        return `Judged: branch \`${this.branch}\` in ${this.root}`;
    }

    /**
     * One `pnpm` cure, AIMED. `bin` is the bare bin name (`wp-start-update`) — the `pnpm` is supplied
     * here, so a caller passing the whole command would produce `pnpm --dir=… pnpm wp-start-update`.
     *
     * `--dir` only when it is needed: in the primary clone this renders the ordinary `pnpm wp-…` every
     * other message in this repo prints, because a `--dir` naming the directory you are already standing
     * in is noise that teaches readers to skip the line.
     */
    pnpmCure(bin: string): string {
        return this.redirected ? `pnpm --dir='${this.root}' ${bin}` : `pnpm ${bin}`;
    }

    /**
     * One NON-pnpm cure, aimed — `cd '<root>' && <command>`, through the shared `atRoot`.
     *
     * NEVER `git -C '<root>' …`. That reads as the cure for "you are in the wrong tree" and is exactly
     * the prescription `l1-matrix.spec.ts` exists to keep out of message-bearing modules: a subagent's
     * `git -C <another tree>` is REFUSED, so an aimed cure written that way is a command the reader
     * cannot run, arriving in the one place they have no reason to doubt it. `atRoot` is the ONE
     * spelling every guard, message builder and pr-gate notice already emits, single quotes included,
     * so a repo path with a space stays runnable.
     */
    cdCure(command: string): string {
        return this.redirected ? atRoot(this.root, command) : command;
    }

    /**
     * The paragraph that turns a printed cure into a runnable one. EMPTY unless the two trees actually
     * differ, for the same reason `pnpmCure` drops `--dir` there.
     *
     * `cures` are FULL command lines, already aimed — `pnpmCure()` for the `wp-*` bins, an explicit
     * `git -C <root> …` for the git ones. Rendering them here from bare names would have to guess which
     * tool takes which "run it over there" flag, and they do not agree.
     */
    redirectNote(cures: readonly string[]): string {
        if (!this.redirected) return '';
        return [
            '',
            'THIS FILE IS NOT IN THE TREE YOU ARE STANDING IN, and the verdict above is about the tree',
            'that OWNS it:',
            `  judged tree   ${this.root}   (branch ${this.branch})`,
            `  your session  ${this.sessionRoot}`,
            'Every command acts on the tree it RUNS IN, so an unqualified cure would repair the wrong',
            'checkout and change nothing here — it reports success and the next edit is blocked',
            'identically. Aim it:',
            ...cures.map((cure: string): string => `  ${cure}`),
        ].join('\n');
    }
}
