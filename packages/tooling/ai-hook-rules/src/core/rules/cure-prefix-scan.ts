import * as path from 'path';

import { CommandScanner, CommandSegment, SegmentJoin } from '../command-scan';
import { ShellSegmentScan } from './shell-segment-scan';

// ---------------------------------------------------------------------------
// COMPOSITION — `<cure> && <work>`, and why `<cure> ; <work>` is a different command.
//
// Measured, not guessed. Across three days of fleet guard logs an agent blocked on a stale `main`
// bundled the cure into the same shell call as the work SIXTEEN times, in two shapes:
//
//     pnpm wp-checkout-clean-main >/dev/null 2>&1; git log --oneline -1; sed -n '598,612p' …
//     git fetch --prune origin main -q && git pull --ff-only origin main 2>&1 | tail -1 && sed -n …
//
// The FIRST is genuinely unsafe and stays blocked. `;` discards the cure's exit code, so the `sed`
// runs against still-stale content whether the pull hit a conflict, a dirty tree or no network — and
// in 7 of the 9 observed cases the agent had also written `>/dev/null 2>&1`, so the failure was
// invisible as well as ignored. The two-step really is safer there, and not for a bureaucratic
// reason: the NEXT tool call is a fresh guard evaluation that recomputes `localMain` against
// `originMain`, so a pull that failed re-blocks. An allowed `;` compound never gets that second look.
//
// The SECOND is the shell already enforcing exactly the property the guard wants. `&&` short-circuits:
// if the cure exits non-zero the work never runs. Blocking it bought nothing and cost a round trip,
// which is why the fleet audit files it as a TOOLING defect rather than an agent one.
//
// So this class answers one question — *does this command START with a refresh-main cure, and what
// operator joins it to the rest?* — and the guard turns that into allow / refuse-and-say-which.
// ---------------------------------------------------------------------------

/**
 * How a leading refresh-main cure is joined to the work behind it.
 *
 *   `none`      the command does not start with a cure at all (or is nothing BUT cure, which the
 *               row 4 skip list already allowed before this class is ever consulted)
 *   `short-circuits`   `&&` — the work is skipped when the cure fails
 *   `runs-anyway`      `;`, `||`, `&`, a newline — the cure's exit code is discarded
 */
export type CureJoinKind = 'none' | 'short-circuits' | 'runs-anyway';

/**
 * What the scan found. Data-only, so a class (per CLAUDE.md).
 *
 * `operator` is the literal shell operator, carried because the refusal message must NAME it: an
 * agent that is told "use `&&`" without being told which character it actually typed has to diff the
 * two spellings itself, and the whole point of this block is to hand over the one edit that fixes it.
 */
export class CurePrefix {
    constructor(readonly kind: CureJoinKind, readonly operator: SegmentJoin) {}
}

const NO_CURE_PREFIX = new CurePrefix('none', 'none');

// The commands that ADVANCE local `main` — the one this repo prescribes, and the raw git verb it
// wraps. Deliberately NOT every `wp-*` bin: a prefix earns the composition allowance because it makes
// the tree fresh, and `pnpm wp-cleanup` does not.
const ADVANCING_BINS: ReadonlySet<string> = new Set(['wp-checkout-clean-main']);
const ADVANCING_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set(['pull']);

// `git fetch` may LEAD the prefix — `git fetch --prune origin main && git pull --ff-only origin main`
// is the shape agents actually type — but it is not itself a cure and never satisfies the prefix on
// its own. A fetch moves the remote-tracking ref and leaves local `main` exactly as far behind as it
// was, so `git fetch && <work>` short-circuits on nothing: the work still reads the stale tree. That
// command gets the ordinary row 6 block, whose message says what a fetch alone does not fix.
const ACCOMPANYING_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set(['fetch']);

export class CurePrefixScan {
    private readonly shell: ShellSegmentScan;

    constructor(private readonly scanner: CommandScanner = new CommandScanner()) {
        this.shell = new ShellSegmentScan(this.scanner);
    }

    /**
     * Classify the LEADING run of segments as a refresh-main cure, and report the operator that joins
     * that run to whatever follows.
     *
     * The run may carry inert company — a leading `cd '<root>'` (which is how every guard renders a
     * remedy that must survive a reset cwd), an `echo`, and the `2>&1 | tail -3` an agent appends by
     * reflex. None of those changes what the cure does, and refusing a command because it was piped
     * into `tail` is the exact defect ShellSegmentScan was written to end.
     */
    classify(command: string): CurePrefix {
        const segments = this.scanner.segmentsWithJoins(command);
        let advanced = false;
        for (const segment of segments) {
            if (this.advancesLocalMain(segment)) { advanced = true; continue; }
            if (this.accompaniesTheCure(segment)) continue;
            // The first segment that is neither. Its join is the verdict — but only once something in
            // the prefix has actually advanced local `main`; otherwise this is an ordinary command
            // that happens to open with a `cd` or a fetch, and row 6 judges it as it always did.
            if (!advanced) return NO_CURE_PREFIX;
            return new CurePrefix(segment.join === '&&' ? 'short-circuits' : 'runs-anyway', segment.join);
        }
        // Nothing but cure and its company — there is no work to protect, and the row 4 skip list has
        // already spoken. Never reached from a blocked path; kept explicit rather than implied.
        return NO_CURE_PREFIX;
    }

    /**
     * Does this segment bring local `main` forward — `git pull`, or the `pnpm wp-checkout-clean-main`
     * that wraps it?
     *
     * A `> file` redirect disqualifies it, with `/dev/null` carved out. `>/dev/null 2>&1` on the cure
     * is only ever an agent muting chatter, and under `&&` the exit code — the thing that matters —
     * still governs. A redirect to a REAL path is a write, and a segment that writes the tree is not
     * something to wave a following command through on the strength of.
     */
    private advancesLocalMain(segment: CommandSegment): boolean {
        const words = this.shell.effectiveWords(segment.text);
        if (words.length === 0) return false;
        if (this.shell.redirectsToFile(words) && !words.some((w: string): boolean => w.includes('/dev/null'))) {
            return false;
        }
        const gitSub = this.scanner.gitSubcommandOf(words);
        if (gitSub !== null) return ADVANCING_GIT_SUBCOMMANDS.has(gitSub);
        return this.scanner.runnerStrippedWords(segment.text)
            .some((word: string): boolean => ADVANCING_BINS.has(path.basename(word)));
    }

    /**
     * Segments that ride along with the cure without being it: shell structure, a `cd`/`echo`, a
     * filter the cure was piped into, and a leading `git fetch`. Anything a pipe fed cannot touch the
     * tree, and a `cd` is how every guard renders a remedy that must survive a reset cwd — so none of
     * them turns a cure prefix into work, and none of them is a cure either.
     */
    private accompaniesTheCure(segment: CommandSegment): boolean {
        if (this.shell.classify(segment).role !== 'command') return true;
        const gitSub = this.scanner.gitSubcommandOf(this.shell.effectiveWords(segment.text));
        return gitSub !== null && ACCOMPANYING_GIT_SUBCOMMANDS.has(gitSub);
    }
}
