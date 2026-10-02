import * as os from 'os';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

/**
 * THE ONE PLACE THAT KNOWS WHERE CLAUDE CODE KEEPS ITS ON-DISK STATE.
 *
 * ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────────
 * `~/.claude` is a DEFAULT, not the location. Claude Code relocates the whole tree when
 * `$CLAUDE_CONFIG_DIR` is set, and three modules in this package read that tree: reviewer provenance
 * (`subagent-provenance.ts`), the audit record (`review-provenance.ts`) and the worktree-reap veto
 * (`harness-agent-activity.ts`). Only the third one resolved it correctly; the other two joined
 * `os.homedir()` with a hardcoded `'.claude'`.
 *
 * The consequence was not a degraded answer, it was a HARD BLOCK with no user-side workaround: on a
 * machine with `CLAUDE_CONFIG_DIR=~/.claude-work`, provenance found zero transcripts — not the
 * reviewers', not even the main agent's — so `wp-finish-upsert-pr` refused every PR whose reviewers
 * had genuinely run and genuinely passed, and the refusal blamed the reviewers' cwd. The audit record
 * it wrote said `mainTranscript: ""`, which is the field that settles it: the main transcript is found
 * by session id alone, with no cwd, branch or stamping involved, so an empty one can ONLY mean the
 * lookup ROOT was wrong. Re-spawning cannot fix a wrong root, and the only escape was a symlink into
 * `~/.claude` — i.e. hand-placing evidence inside a verification gate's own evidence tree.
 *
 * So the resolution lives here once, and the three modules call it. A second copy is how the first one
 * got out of step.
 *
 * ─── WHY BOTH ROOTS ARE SEARCHED ─────────────────────────────────────────────────────────────────
 * `$CLAUDE_CONFIG_DIR` is a property of the PROCESS, and the process that runs `wp-finish-upsert-pr`
 * is not the process that wrote the transcripts. A shell launched before the variable was exported —
 * or a hook, or a `pnpm` script whose env was sanitized — reads the transcripts of a session that had
 * it set while itself having it unset, and vice versa. Resolving to exactly ONE root makes the check
 * depend on env agreement between two unrelated processes, which is a fact nobody can verify and
 * nobody can repair from inside the flow.
 *
 * Searching both is cheap (a `readdir` of a directory that usually does not exist) and it only ever
 * ADDS candidate trees. It cannot weaken the integrity property either: every root yields the same
 * harness-written `spawnDepth` / `isSidechain` / branch evidence, so a transcript found under the
 * second root is no more forgeable than one found under the first.
 *
 * Shaped like {@link ClaudeEnv} in `claude-env.ts` — an injectable class plus one process-wide
 * instance — because `no-function-outside-class` is on: module-scope helpers are not a shape this repo
 * writes, whatever their arity.
 */

/** The env var Claude Code exports when its config tree has been relocated. */
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

@injectable(bindingScopeValues.Singleton)
export class ClaudeConfigDir {
    /** The raw `$CLAUDE_CONFIG_DIR` value, or '' when it is not set. For DIAGNOSTICS, never for joining. */
    configuredDir(): string {
        return (process.env[CLAUDE_CONFIG_DIR_ENV] ?? '').trim();
    }

    /** Claude Code's config tree: `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`. */
    root(): string {
        const configured = this.configuredDir();
        return configured !== '' ? configured : path.join(os.homedir(), '.claude');
    }

    /**
     * Every config tree worth searching: the configured one FIRST, then `~/.claude` when it is a
     * different directory. See the both-roots note above for why this is a list and not one answer.
     */
    roots(): string[] {
        const configured = this.root();
        const fallback = path.join(os.homedir(), '.claude');
        return path.resolve(configured) === path.resolve(fallback) ? [configured] : [configured, fallback];
    }

    /**
     * `<config>/projects` for every root {@link roots} names, in the same order — where per-project
     * session state and transcripts live.
     *
     * There is deliberately NO singular `projectsRoot()` beside this. Searching exactly one root is
     * precisely the defect #963 was, so an exported spelling that returns the one-root answer would make
     * the broken thing the shorter thing to type, in the one file that exists to prevent it.
     */
    projectsRoots(): string[] {
        return this.roots().map((root: string): string => path.join(root, 'projects'));
    }
}

// Process-wide instance for the many non-DI call sites (hooks, wp-* bins); inversify still injects the
// singleton wherever a container is in play. Same arrangement as `claudeEnv`.
export const claudeConfigDir = new ClaudeConfigDir();
