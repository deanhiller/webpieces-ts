import { CommandScanner } from '../command-scan';

/** Which shell construct was found inside an inline commit message. */
export type MessageHazardKind = 'backtick' | 'command-substitution' | 'newline';

/**
 * One hazard found in one inline `-m` message: the flag that carried it, what it is, and the text
 * around it. Data-only → a class, per CLAUDE.md.
 *
 * `excerpt` is a short window around the hit rather than the whole message: the refusal is read
 * mid-task, and a 40-line commit message pasted back at the agent buries the one thing it must see.
 */
export class MessageHazard {
    constructor(
        readonly flag: string,
        readonly kind: MessageHazardKind,
        readonly excerpt: string,
    ) {}
}

/** One hazard kind and the literal text that betrays it, in the order they are reported. */
class HazardNeedle {
    constructor(readonly kind: MessageHazardKind, readonly needle: string) {}
}

/**
 * The three constructs that make a commit message dangerous, and NOTHING about the words around them.
 *
 * A blocklist of "dangerous commands" would have missed the incident this exists for entirely — the
 * word that hung was `strings`, which is as ordinary as a word gets. The hazard is the METACHARACTER.
 */
const HAZARDS: readonly HazardNeedle[] = [
    new HazardNeedle('backtick', '`'),
    new HazardNeedle('command-substitution', '$('),
    new HazardNeedle('newline', '\n'),
];

// A short cluster of git-commit boolean short flags that may legally precede `m` in one bundle
// (`-am`, `-qm`, `-asm`). Deliberately NOT `[A-Za-z]*`: `-Sabcmdef` (a gpg key id containing an `m`)
// would then read as a message flag with an attached message.
const SHORT_FLAG_CLUSTER = /^-([asevqnoup]*)m(.*)$/;

const LONG_MESSAGE_FLAG = '--message';

/**
 * Finds a commit message passed INLINE (`-m` / `--message` / `-am`) whose text carries a shell
 * construct the shell will expand before git ever sees it.
 *
 * Split out from the guard for the same reason `WholeRepoBuildScan` is: WHAT counts as a hit is a
 * tokenizer question with its own tests, while the guard owns the verdict, the log line and the words
 * of the refusal.
 */
export class CommitMessageSubstitutionScan {
    constructor(private readonly scanner: CommandScanner) {}

    /**
     * The first hazard anywhere in the command, or null.
     *
     * `command` is the RAW command — see the guard's docstring for why `commandCode` cannot be used.
     */
    firstHit(command: string): MessageHazard | null {
        for (const segment of this.scanner.commandSegments(command)) {
            const args = this.scanner.gitSubcommandArgs(segment, 'commit');
            if (args === null) continue;
            const hit = this.hazardInArgs(args);
            if (hit !== null) return hit;
        }
        return null;
    }

    private hazardInArgs(args: readonly string[]): MessageHazard | null {
        for (let i = 0; i < args.length; i++) {
            const flag = args[i];
            const attached = this.attachedMessage(flag);
            if (attached !== null) {
                const hit = this.hazardIn(flag, attached);
                if (hit !== null) return hit;
                continue;
            }
            if (!this.takesFollowingMessage(flag)) continue;
            // The value is the NEXT token, and it may be absent (`git commit -m` alone, which git
            // itself rejects). Nothing to inspect then — a guard never fails on a malformed command.
            const text = args[i + 1];
            i++;
            if (text === undefined) continue;
            const hit = this.hazardIn(flag, text);
            if (hit !== null) return hit;
        }
        return null;
    }

    /** The message carried IN the flag token itself (`-mfix`, `--message=fix`), or null. */
    private attachedMessage(flag: string): string | null {
        if (flag.startsWith(`${LONG_MESSAGE_FLAG}=`)) return flag.slice(LONG_MESSAGE_FLAG.length + 1);
        // `--amend`, `--no-edit`, `--fixup=…` — every other long flag, and never a message.
        if (flag.startsWith('--')) return null;
        const cluster = SHORT_FLAG_CLUSTER.exec(flag);
        if (cluster === null) return null;
        return cluster[2] === '' ? null : cluster[2];
    }

    /** True when the flag's message is the FOLLOWING token (`-m msg`, `-am msg`, `--message msg`). */
    private takesFollowingMessage(flag: string): boolean {
        if (flag === LONG_MESSAGE_FLAG) return true;
        if (flag.startsWith('--')) return false;
        const cluster = SHORT_FLAG_CLUSTER.exec(flag);
        return cluster !== null && cluster[2] === '';
    }

    /** The EARLIEST hazard in this text, so the excerpt points at what the shell hits first. */
    private hazardIn(flag: string, text: string): MessageHazard | null {
        let best: MessageHazard | null = null;
        let bestAt = text.length;
        for (const hazard of HAZARDS) {
            const at = text.indexOf(hazard.needle);
            if (at === -1 || at >= bestAt) continue;
            bestAt = at;
            best = new MessageHazard(flag, hazard.kind, this.excerpt(text, at));
        }
        return best;
    }

    // A window around the hit, newlines shown as `\n` so the excerpt stays one line in the report.
    private excerpt(text: string, at: number): string {
        const BEFORE = 30;
        const AFTER = 40;
        const start = Math.max(0, at - BEFORE);
        const end = Math.min(text.length, at + AFTER);
        const body = text.slice(start, end).replace(/\n/g, '\\n');
        return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
    }
}
