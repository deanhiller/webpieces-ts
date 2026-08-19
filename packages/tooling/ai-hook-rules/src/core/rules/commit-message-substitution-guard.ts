import { Option } from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase, EmptyRuleConfig } from '../rule-base';
import { FixHint } from '../fix-hint';
import { L0_FAULT_NONE } from '../l0-fault-codes';
import { logGuardDecision, GuardDecision, Verdict, MATRIX_L2_UNROWED } from '../decision-log';
import { CommandScanner } from '../command-scan';
import { CommitMessageSubstitutionScan, MessageHazard, MessageHazardKind } from './commit-message-substitution-scan';

/**
 * Blocks `git commit` whose message is passed INLINE (`-m` / `--message` / `-am`) when that message
 * contains a backtick, a `$(`, or a newline — and hands back `git commit -F <file>` instead.
 *
 * ─── The incident: a commit message that HUNG for ten minutes, twice ───────────────────────────────
 * An agent ran `git commit -q -m "…"` with a multi-paragraph message that happened to contain the
 * sentence: *"… `strings` on a .app built with --port 8084 contains no 8084."* The backticks are
 * COMMAND SUBSTITUTION. The shell ran `strings` with no arguments, `strings` read stdin, and stdin
 * never closed. The Bash tool SIGTERM'd it at its ten-minute cap. The retry kept the same sentence and
 * did it again — twenty minutes for one commit.
 *
 * ─── Why this is a GUARD and not a doc line ────────────────────────────────────────────────────────
 * The agent then diagnosed it as "a guard caught a commit message that quoting a blocked command",
 * citing an unrelated deploy-guard note. Three facts settle that it was nothing of the kind, and they
 * are worth writing down because they are the reason the cure has to arrive BEFORE execution:
 *
 *   - a PreToolUse guard denies INSTANTLY, before the command runs. This ran for ten minutes.
 *   - `Exit code 143` is SIGTERM delivered to a RUNNING process, not a refusal.
 *   - the first attempt was `git add -A && git commit -m "…"`, and afterwards the 45 files were
 *     STAGED — so the command really executed, and then blocked while expanding its second word.
 *
 * A footnote in a doc could not have reached that agent at that moment; a refusal naming `-F` does.
 *
 * ─── The trigger is the METACHARACTER, never the words ─────────────────────────────────────────────
 * A message is PROSE, and prose goes through the shell's expansion rules whether or not it is meant
 * to. A blocklist of "dangerous commands" would have missed this entirely — `strings` is an ordinary
 * word, and the next hang will name an ordinary word too. So the rule matches backtick, `$(` and a
 * newline inside the message argument, and reads nothing at all into the surrounding sentence.
 *
 * ─── It fires on a SINGLE-QUOTED message too, and that is deliberate ───────────────────────────────
 * `git commit -m 'a `backtick` here'` is, strictly, safe: single quotes suppress substitution, so the
 * shell would pass those backticks through literally. This guard blocks it anyway, and the false
 * positive is the point rather than an oversight — do not "fix" it. Two reasons:
 *
 *   - single-quoting PROSE is fragile in the one way that matters. An English sentence eventually
 *     contains an apostrophe ("doesn't", "the agent's"), which CLOSES the quote mid-message and drops
 *     the rest of the sentence back into the shell's syntax — the exact state this guard exists to
 *     prevent, reached by a message that looked safe when it was written.
 *   - the cure is free. `-F` costs one Write tool call and works for every message, so being wrong
 *     here spends seconds, while being right saves twenty minutes. A guard chooses its errors by what
 *     each one COSTS, and these two costs are not close.
 *
 * `blocks a single-quoted message too` in the spec pins this, so a later reader meets the decision as
 * a failing test rather than as a bug report.
 *
 * ─── It matches the RAW command, and that is load-bearing ──────────────────────────────────────────
 * Every other bash guard here matches `ctx.commandCode`, which STRIPS heredoc bodies and quoted prose
 * precisely so a commit message merely MENTIONING `git push` is not read as a push. That stripping
 * deletes exactly the span this rule exists to inspect: on `commandCode` the message is already gone,
 * and the guard would be permanently blind. So it reads `ctx.command`.
 *
 * That is safe here because the rule is still blocklist-shaped and its cure can never itself be
 * blocked: `-F` writes the message to a file and passes a PATH, so nothing about the message text can
 * make the replacement command match this guard. There is no input for which an agent is left with no
 * accepted spelling.
 */
export class CommitMessageSubstitutionGuardRule extends BashRuleBase<EmptyRuleConfig> {
    constructor() {
        // configKey === name and is DELIBERATELY not a real webpieces.config.json key. Like
        // whole-repo-build-guard, this guard is loaded OUTSIDE the config-driven set, so the fault-Y
        // config-sync check ("every built-in rule needs an entry, or every Bash call is blocked") can
        // never see it — a new guard that every consumer must configure to avoid being blocked is a
        // guard that ships an outage on upgrade, which has happened here once already.
        super(new EmptyRuleConfig(), 'commit-message-substitution-guard', 'commit-message-substitution-guard');
    }

    private readonly scan = new CommitMessageSubstitutionScan(new CommandScanner());

    readonly description =
        'Block `git commit -m` whose inline message contains a backtick, `$(` or a newline — the shell ' +
        'expands those before git sees them — and name `git commit -F` instead.';

    get fixHint(): FixHint {
        return new FixHint(
            'A commit message passed with -m goes through the shell. A backtick or $( in it is COMMAND ' +
            'SUBSTITUTION, and a substituted command that reads stdin hangs until the tool times out.',
            'Keep the message text out of the shell\'s expansion path — pass a PATH, not prose:',
            [
                new Option(
                    'Write the message to a file with the Write tool, then:\n' +
                    'git commit -F /tmp/commit-msg.txt',
                    true,
                ),
                new Option(
                    'Feed it on stdin from a QUOTED heredoc:\n' +
                    'git commit -F - <<\'EOF\'\n' +
                    '<your message>\n' +
                    'EOF\n' +
                    'The quotes around EOF are what disable substitution. An unquoted <<EOF does NOT — ' +
                    'the body is still expanded, and you are back where you started.',
                ),
            ],
        );
    }

    check(ctx: BashContext): readonly Violation[] {
        // RAW, not commandCode — see the class docstring. commandCode strips the quoted prose this
        // rule's entire subject is, so matching on it would make the guard permanently blind.
        const hit = this.scan.firstHit(ctx.command);
        if (hit === null) return this.allow(ctx, 'no-inline-message-hazard');
        return this.block(ctx, hit);
    }

    private allow(ctx: BashContext, reason: string): readonly Violation[] {
        this.logDecision(ctx, 'ALLOW', reason);
        return [];
    }

    private block(ctx: BashContext, hit: MessageHazard): readonly Violation[] {
        // BLOCK_AI_CURE: the cure is two commands the agent runs itself, both spelled out in fixHint.
        this.logDecision(ctx, 'BLOCK_AI_CURE', `inline-message-${hit.kind}`);
        return [new V(1, this.truncate(ctx.command), this.message(hit))];
    }

    // Short on purpose: it is read mid-task by an agent that needs the ONE next move.
    private message(hit: MessageHazard): string {
        return `Blocked: the ${hit.flag} message contains ${this.what(hit.kind)}, which the SHELL acts on `
            + 'before git ever sees the message.\n\n'
            + `    ${hit.excerpt}\n\n`
            + 'Write the message to a file with the Write tool and commit with `git commit -F <file>`, or '
            + 'pipe it in with a QUOTED heredoc: `git commit -F - <<\'EOF\'`.';
    }

    private what(kind: MessageHazardKind): string {
        if (kind === 'backtick') return 'a BACKTICK (command substitution — `cmd` runs cmd)';
        if (kind === 'command-substitution') return 'a `$(` (command substitution)';
        return 'a NEWLINE (a multi-paragraph message belongs in a file — that is where the backticks hide)';
    }

    private truncate(s: string): string {
        const MAX = 120;
        return s.length <= MAX ? s : s.slice(0, MAX) + '…';
    }

    private logDecision(ctx: BashContext, verdict: Verdict, reason: string): void {
        logGuardDecision(
            ctx.workspaceRoot,
            new GuardDecision(
                'commit-message-substitution-guard', 'Bash', ctx.command, '-', verdict, reason,
                '-', L0_FAULT_NONE, MATRIX_L2_UNROWED,
            ),
        );
    }
}
