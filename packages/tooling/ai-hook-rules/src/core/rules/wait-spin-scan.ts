import { CommandScanner, CommandSegment } from '../command-scan';
import { ShellSegmentScan } from './shell-segment-scan';

/**
 * Decides the one question `wait-spin-guard` asks of a command's TEXT: is this command, all by itself,
 * a way of staying alive rather than a way of doing something?
 *
 * ─── The two shapes, and why only these ────────────────────────────────────────────────────────────
 *
 *   NO-OP     the whole command produces no effect an agent could act on — `echo .`, `echo idle3`,
 *             `true`, `:`, `date -u +%H:%M`. Measured across the fleet in the 24h to 2026-09-07: ten
 *             agent runs spun this way, 920M tokens (18.3% of fleet tokens) burned, because every turn
 *             resends the whole conversation at ~557k tokens. Nobody types these to learn anything.
 *
 *   POLL      an identical `gh pr checks <n>` / `gh pr view <n>`, run over and over. ONE of these is a
 *             legitimate snapshot and must stay allowed — it is the difference between asking a
 *             question and refusing to stop asking it — so this scan only CLASSIFIES the shape, and
 *             the guard decides on the session's own call history whether it has been asked before.
 *
 * ─── What is NOT a hit, and why the carve-outs are the whole risk ──────────────────────────────────
 * `echo` is everywhere in legitimate work, and a false positive here breaks ordinary commands rather
 * than merely annoying somebody. Three rules keep it honest, and every one of them is drawn from real
 * lines in this repo's own guard logs:
 *
 *   ONE SEGMENT ONLY  `echo "=== IN-SCOPE DIFF ===" && git diff …` and
 *                     `sed -n 1,50p f.ts; echo ---; sed -n 60,90p f.ts` are compound commands that DO
 *                     something. A command with a second segment is never a hit, whatever the first
 *                     segment is.
 *   NO REDIRECT       `echo "$body" > /tmp/pr-body.md` writes a file. `ShellSegmentScan.redirectsToFile`
 *                     owns that test (and its `2>&1` carve-out), shared rather than re-spelled here.
 *   NO PIPE           a pipe is a second segment, so this falls out of the segment rule; `date | xargs …`
 *                     is a real command and is allowed by construction.
 *
 * The argument shape is deliberately narrow too: at most ONE argument, and it must be a short bare
 * token (`.`, `idle4`, `waiting-for-reviewers`). `echo $PATH` and `echo -n .` are allowed — missing a
 * spin costs one turn, and refusing a real command costs the task.
 *
 * ─── The ONE exception to ONE SEGMENT ONLY, and it is POLL-shaped only (issue #878) ────────────────
 * A pipe on a NO-OP is a second command doing work, and that carve-out stays exactly as written. A
 * TRAILING PAGER on a POLL is not: `gh pr checks 1058 2>&1 | head` asks the identical question as
 * `gh pr checks 1058 2>&1` and is the same spin wearing a hat. Measured over 30 days it is the
 * majority form — `gh pr checks 464 2>&1 | head` 173 times, `gh pr checks 1058 2>&1 | head` 81,
 * `gh pr checks 428 2>&1 | head -10` 72 — worth 15.5% of one repo's wait waste and 7.4% of another's,
 * all of it invisible to the single-segment rule.
 *
 * So a trailing {@link PAGER_PROGRAMS} segment is normalised away before the head segment is
 * classified, and the result is then accepted ONLY when it is a POLL. `date | xargs …` and
 * `echo x | head` stay allowed, because a NO-OP hit reached through a pipe is discarded — the
 * single-segment rule is not relaxed, it is bypassed for one shape whose repeat count is the defect.
 */

/** The whole command does nothing — an `echo`/`true`/`:`/`date` keep-alive. */
export const SPIN_NOOP = 'noop';
/** The whole command is a PR/CI status read. Only a REPEAT of one is a spin; the guard decides that. */
export const SPIN_POLL = 'poll';

/** Programs whose bare invocation is a keep-alive and nothing else. */
export const NOOP_PROGRAMS: readonly string[] = ['echo', 'true', ':', 'date'];

/** `gh pr <subcommand>` reads that say nothing new when repeated against an unchanged PR. */
export const POLLED_GH_SUBCOMMANDS: readonly string[] = ['checks', 'view'];

/**
 * Pagers that may trail a POLL through a pipe without changing the question it asks. Narrow on
 * purpose: every one of these only TRUNCATES its input, so the command in front of it is still the
 * whole command. `grep`, `jq` and `awk` are deliberately absent — `gh pr checks 874 | grep fail` asks
 * a narrower question than the bare poll, somebody is reading the answer, and it stays allowed.
 */
export const PAGER_PROGRAMS: readonly string[] = ['head', 'tail', 'cat', 'wc'];

/**
 * The flag that turns `gh pr checks` from a poll into a BLOCKING wait, and is therefore never a spin.
 *
 * Measured over the same window: 224 subagent calls and 84 main-agent calls carried it. It is a
 * legitimate wait primitive — one call that blocks — which is the very thing this guard exists to push
 * agents towards, so refusing it however often it appears would refuse the cure. (`wp-await-checks`
 * still earns its place beside it: `--watch` has no bounded exit and the harness kills it at 600s
 * having printed nothing, whereas `wp-await-checks` heartbeats and returns cleanly at 540s.)
 */
export const BLOCKING_WATCH_FLAG = '--watch';

const NOOP_SET: ReadonlySet<string> = new Set(NOOP_PROGRAMS);
const POLLED_SET: ReadonlySet<string> = new Set(POLLED_GH_SUBCOMMANDS);
const PAGER_SET: ReadonlySet<string> = new Set(PAGER_PROGRAMS);

/**
 * The KEEP-ALIVE TOKENS, and nothing wider.
 *
 * This started as "any short bare token" and that was measurably too wide. Two real commands matched:
 * `echo hi`, which is a benign line in this package's own golden fixtures, and the prose-stripped
 * remains of an `echo "<a sentence>"`, which `runner.spec.ts` asserts is NOT blocked. Both are commands
 * somebody meant, and a guard that refuses those is a guard someone turns off.
 *
 * So the family is NAMED rather than inferred: the dot runs, plus the words the measured spins actually
 * used, each free to carry a numeric or hyphenated tail (`idle3`, `waiting-for-reviewers`). Anything
 * else `echo` prints is content, and content is allowed.
 */
const KEEP_ALIVE_TOKEN =
    /^(?:\.{1,3}|(?:idle|ok|okay|waiting|wait|standby|still|alive|ping|pong|tick|noop|nop|heartbeat|zzz)[a-z0-9_-]*)$/i;

/** One spin-shaped command: WHICH shape, and the program that produced it. Data-only (per CLAUDE.md). */
export class WaitSpinHit {
    shape: string;
    program: string;

    constructor(shape: string, program: string) {
        this.shape = shape;
        this.program = program;
    }
}

export class WaitSpinScan {
    constructor(
        private readonly scanner: CommandScanner,
        private readonly segments: ShellSegmentScan,
    ) {}

    /** The spin shape this whole command is, or null when it is a real command. */
    classify(command: string): WaitSpinHit | null {
        const parts = this.scanner.segmentsWithJoins(command);
        if (parts.length === 1) return this.classifySegment(parts[0].text, false);
        if (this.endsInPager(parts)) return this.classifySegment(parts[0].text, true);
        return null;
    }

    /**
     * Classify ONE segment's words. `pollOnly` is set when the segment was reached by stripping a
     * trailing pager, and it discards a NO-OP hit: `echo . | head` is a pipe into a real program and
     * must stay allowed, while `gh pr checks 5 | head` is the same poll as `gh pr checks 5`.
     */
    private classifySegment(text: string, pollOnly: boolean): WaitSpinHit | null {
        const words = this.scanner.runnerStrippedWords(text);
        if (words.length === 0) return null;
        if (this.segments.redirectsToFile(words)) return null;
        const hit = this.classifyWords(words);
        if (hit === null) return null;
        return pollOnly && hit.shape !== SPIN_POLL ? null : hit;
    }

    private classifyWords(words: readonly string[]): WaitSpinHit | null {
        const program = this.scanner.programName(words[0]);
        if (this.isPoll(program, words)) return new WaitSpinHit(SPIN_POLL, this.pollLabel(words));
        if (!NOOP_SET.has(program)) return null;
        return this.isNoop(program, words) ? new WaitSpinHit(SPIN_NOOP, program) : null;
    }

    /** Exactly two segments, joined by a pipe, the second of which only truncates its input. */
    private endsInPager(parts: readonly CommandSegment[]): boolean {
        if (parts.length !== 2 || parts[1].join !== '|') return false;
        const words = this.scanner.runnerStrippedWords(parts[1].text);
        return words.length > 0 && this.isPagerWords(words);
    }

    /**
     * `head`, `tail`, `cat`, `wc -l` — and ONLY with the argument shapes that keep them pure
     * truncations. `head -c 1 file` names a file and `wc -c` counts something else, so an unrecognised
     * argument means "not a pager", which means the whole command falls back to the segment rule and
     * is allowed. Missing a spin costs one turn; refusing a real command costs the task.
     */
    private isPagerWords(words: readonly string[]): boolean {
        const program = this.scanner.programName(words[0]);
        if (!PAGER_SET.has(program)) return false;
        const args = words.slice(1);
        if (program === 'cat') return args.length === 0;
        if (program === 'wc') return args.length === 1 && args[0] === '-l';
        if (args.length === 0) return true;
        if (args.length === 1) return /^-\d+$/.test(args[0]);
        return args.length === 2 && args[0] === '-n' && /^\d+$/.test(args[1]);
    }

    /**
     * `echo` must carry EXACTLY ONE keep-alive token. A BARE `echo` is deliberately not a hit: quoted
     * prose is stripped out of `commandCode`, so `echo "<any sentence>"` arrives here as a bare `echo`,
     * and blocking that shape refuses a command whose content nobody ever looked at.
     *
     * `true`, `:` and `date` are judged whole: `date -u +%H:%M` prints the clock and nothing else,
     * whatever its format string.
     */
    private isNoop(program: string, words: readonly string[]): boolean {
        if (program === 'true' || program === ':') return words.length === 1;
        if (program === 'date') return true;
        return words.length === 2 && KEEP_ALIVE_TOKEN.test(words[1]);
    }

    /**
     * A `gh pr checks/view` read — EXCEPT when it carries {@link BLOCKING_WATCH_FLAG}, which makes it
     * one blocking call rather than a poll. See that constant for why that exception is load-bearing.
     */
    private isPoll(program: string, words: readonly string[]): boolean {
        if (program !== 'gh' || words.length < 3 || words[1] !== 'pr') return false;
        if (!POLLED_SET.has(words[2])) return false;
        return !words.includes(BLOCKING_WATCH_FLAG);
    }

    // `gh pr checks` / `gh pr view` — the label the refusal prints, without the PR number or the flags,
    // which the guard already has in the raw command.
    private pollLabel(words: readonly string[]): string {
        return `gh pr ${words[2]}`;
    }
}
