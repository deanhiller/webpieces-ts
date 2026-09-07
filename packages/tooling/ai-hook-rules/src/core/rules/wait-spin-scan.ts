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
 */

/** The whole command does nothing — an `echo`/`true`/`:`/`date` keep-alive. */
export const SPIN_NOOP = 'noop';
/** The whole command is a PR/CI status read. Only a REPEAT of one is a spin; the guard decides that. */
export const SPIN_POLL = 'poll';

/** Programs whose bare invocation is a keep-alive and nothing else. */
export const NOOP_PROGRAMS: readonly string[] = ['echo', 'true', ':', 'date'];

/** `gh pr <subcommand>` reads that say nothing new when repeated against an unchanged PR. */
export const POLLED_GH_SUBCOMMANDS: readonly string[] = ['checks', 'view'];

const NOOP_SET: ReadonlySet<string> = new Set(NOOP_PROGRAMS);
const POLLED_SET: ReadonlySet<string> = new Set(POLLED_GH_SUBCOMMANDS);

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
        if (parts.length !== 1) return null;
        const words = this.scanner.runnerStrippedWords(parts[0].text);
        if (words.length === 0) return null;
        if (this.segments.redirectsToFile(words)) return null;
        return this.classifyWords(words);
    }

    private classifyWords(words: readonly string[]): WaitSpinHit | null {
        const program = this.scanner.programName(words[0]);
        if (this.isPoll(program, words)) return new WaitSpinHit(SPIN_POLL, this.pollLabel(words));
        if (!NOOP_SET.has(program)) return null;
        return this.isNoop(program, words) ? new WaitSpinHit(SPIN_NOOP, program) : null;
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

    private isPoll(program: string, words: readonly string[]): boolean {
        return program === 'gh' && words.length >= 3 && words[1] === 'pr' && POLLED_SET.has(words[2]);
    }

    // `gh pr checks` / `gh pr view` — the label the refusal prints, without the PR number or the flags,
    // which the guard already has in the raw command.
    private pollLabel(words: readonly string[]): string {
        return `gh pr ${words[2]}`;
    }
}
