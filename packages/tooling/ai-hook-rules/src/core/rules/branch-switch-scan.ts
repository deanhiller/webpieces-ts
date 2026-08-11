import { CommandScanner } from '../command-scan';

/**
 * "Which branch does this `git checkout` / `git switch` land me on?" — the ONE place that question is
 * answered, for every guard that asks it.
 *
 * It used to be answered by two regexes in redirect-how-to-merge-main
 * (`/git\s+(?:checkout|switch)\s+main\b/` to EXEMPT main, and a negative-lookahead twin to catch a
 * feature switch) and by a third, hand-rolled word walk in stale-main-bash-guard. The regex pair
 * assumed the branch name is the token immediately after the subcommand, so ONE flag broke it:
 *
 *   git checkout main         → exempted (correct)
 *   git checkout -q main      → `main` no longer follows `checkout`, so the exemption MISSED, the
 *                               lookahead concluded the target was not main, and the command was
 *                               blocked with "this switches to a feature branch and then pulls main
 *                               into it" — the exact opposite of what it does.
 *
 * That block landed on the cure stale-main-bash-guard itself prescribes, so the two guards
 * contradicted each other and a human had to route around both to update main. The fix is not a
 * cleverer regex: it is to TOKENIZE (CommandScanner already does the hard part) and walk the flags,
 * which is also why it must exist once rather than three times.
 *
 * Deliberately NOT "does the string contain main" — over-matching here is worse than the original
 * bug, because `git checkout -b feature/main-thing` and `git checkout -- main.ts` would then read as
 * "switching to main" and be EXEMPTED from a guard whose whole job is to catch a feature-branch pull.
 */
const CREATE_FLAGS: ReadonlySet<string> = new Set(['-b', '-B', '-c', '-C', '--orphan']);

// Non-creating flags that consume the FOLLOWING token, so its value is never mistaken for the target.
const FLAGS_WITH_VALUE: ReadonlySet<string> = new Set(['--conflict', '--pathspec-from-file', '--start-point']);

/**
 * The branch a checkout/switch lands on, and whether that command CREATES it.
 *
 * `created` is load-bearing rather than cosmetic: `git checkout -b x origin/main` lands on a branch
 * that is current by construction (nothing to be stale about), whereas landing on an EXISTING local
 * `main` is exactly the stale-checkout hazard. Data-only, so a class (per CLAUDE.md).
 */
export class BranchSwitch {
    branch: string;
    created: boolean;

    constructor(branch: string, created: boolean) {
        this.branch = branch;
        this.created = created;
    }
}

export class BranchSwitchScan {
    constructor(private readonly scanner: CommandScanner = new CommandScanner()) {}

    /**
     * The branch this segment switches to, or null when the segment does not land on a branch at all:
     * a different command, no target word, `git checkout -` (the previous branch — unknowable here),
     * or anything after `--` (which ends option parsing, making the rest PATHSPECS, so
     * `git checkout -- main` restores a FILE named main and moves no branch).
     *
     * Flag-tolerant by construction: every leading flag is walked past, so `-q`, `--quiet`,
     * `--no-track`, `--detach` and friends change nothing about which word is the target.
     */
    targetOf(segment: string): BranchSwitch | null {
        const subcommand = this.scanner.gitSubcommand(segment);
        if (subcommand !== 'checkout' && subcommand !== 'switch') return null;

        const words = this.scanner.words(segment);
        const args = words.slice(words.indexOf(subcommand) + 1);

        for (let i = 0; i < args.length; i++) {
            const word = args[i];
            if (word === '--') return null;
            if (word === '-') return null;
            const created = this.createdBranch(args, i);
            if (created !== null) return created;
            if (FLAGS_WITH_VALUE.has(word)) { i++; continue; }
            if (word.startsWith('-')) continue;
            return new BranchSwitch(word, false);
        }
        return null;
    }

    /**
     * True only for landing on an EXISTING branch named `main` — the form that can hand you a stale
     * tree, and the form `git checkout main && git pull origin main` uses. `-b`/`-B`/`-c`/`-C` are
     * excluded because they create the branch here and now.
     */
    landsOnExistingMain(segment: string): boolean {
        const target = this.targetOf(segment);
        return target !== null && this.isExistingMain(target);
    }

    /** The same question for a target already parsed (switchesIn). One spelling, two entry shapes. */
    isExistingMain(target: BranchSwitch): boolean {
        return target.branch === 'main' && !target.created;
    }

    /** Every segment of a whole command that lands on a branch, in order. */
    switchesIn(command: string): readonly BranchSwitch[] {
        const found: BranchSwitch[] = [];
        for (const segment of this.scanner.commandSegments(command)) {
            const target = this.targetOf(segment);
            if (target !== null) found.push(target);
        }
        return found;
    }

    // `-b <name>` / `--orphan=<name>` — the new branch's name, or null when this word creates nothing.
    private createdBranch(args: readonly string[], i: number): BranchSwitch | null {
        const word = args[i];
        if (CREATE_FLAGS.has(word)) {
            const name = args[i + 1];
            if (name === undefined || name.startsWith('-')) return null;
            return new BranchSwitch(name, true);
        }
        const equals = word.indexOf('=');
        if (equals > 0 && CREATE_FLAGS.has(word.slice(0, equals))) {
            return new BranchSwitch(word.slice(equals + 1), true);
        }
        return null;
    }
}
