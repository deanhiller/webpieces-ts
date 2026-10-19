import { CommandScanner, CommandSegment } from '@webpieces/hook-runtime';

/**
 * Is this Bash command a PLAIN `git add` — the cure for an untracked declared policy file (#1327)?
 *
 * While `UntrackedPolicyError` is the reason the config will not load, every Bash call is denied with
 * that refusal, and the refusal's own cure is `git add <the files>`. Denying it sent agents round the
 * same deny until they found `wp-migrate-dirs --stage`. The runner asks this question ONLY while that
 * specific refusal is active, so a healthy tree never sees it.
 *
 * ANY plain `git add` passes, not only one whose pathspecs cover the missing files, deliberately:
 *   - `git add` touches only the index; it commits nothing, pushes nothing, and `git restore --staged`
 *     undoes it. There is nothing to protect by narrowing it further;
 *   - matching pathspecs against the missing files means re-implementing git's pathspec semantics
 *     (directories, globs, `-A`, `.`, `:(top)` magic) — and every mismatch is the loop coming back,
 *     because an agent's natural `git add -A` or `git add .webpieces-config` would be refused again.
 *
 * What it refuses is everything that could make the command do MORE than stage: any segment that is
 * not `git add` (an optional leading `cd <literal path> &&` excepted), a pipe or background `&`, and any
 * `$`, backtick or redirect — command substitution inside double quotes is not split out by the
 * scanner, so the characters themselves are refused rather than trusting the split.
 */
export class PolicyStagingCommand {
    constructor(private readonly scanner: CommandScanner = new CommandScanner()) {}

    isPlainGitAdd(command: string): boolean {
        // A trailing `&` leaves no segment to carry its join, so pipes and lone `&` are refused as text.
        if (/[`$<>|]/.test(command) || command.replace(/&&/g, '').includes('&')) return false;
        const segments = this.scanner.segmentsWithJoins(command);
        if (segments.length === 0) return false;
        let staged = false;
        for (let index = 0; index < segments.length; index++) {
            const segment = segments[index];
            if (!this.sequential(segment)) return false;
            if (index === 0 && segments.length > 1 && /^cd\s+\S+$/.test(segment.text)) continue;
            // The RAW text, not `words()`: that strips `sudo` / `env` / `VAR=x` prefixes, and
            // `GIT_DIR=… git add` stages into some other repository.
            if (!/^git\s+add(\s|$)/.test(segment.text)) return false;
            staged = true;
        }
        return staged;
    }

    // `&&` / `;` / newline only: a pipe hands git's output to another program, `&` backgrounds it.
    private sequential(segment: CommandSegment): boolean {
        return segment.join === 'none' || segment.join === '&&' || segment.join === ';' || segment.join === '\n';
    }
}
