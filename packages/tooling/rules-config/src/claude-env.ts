import { injectable, bindingScopeValues } from 'inversify';

/** The env var Claude Code exports to hook processes, naming the project it launched against. */
export const CLAUDE_PROJECT_DIR_ENV = 'CLAUDE_PROJECT_DIR';

/**
 * The literal recorded when `CLAUDE_PROJECT_DIR` is ABSENT from the environment. Deliberately a
 * distinct token rather than an empty string: "the variable is not set" and "the variable is set to
 * nothing" are different facts, and the first one is itself a finding — the var reaches hook
 * processes but NOT plain Bash tool calls, so an agent cannot see it by running `env`.
 */
export const CLAUDE_PROJECT_DIR_UNSET = '<unset>';

/**
 * The ONE reader of `CLAUDE_PROJECT_DIR`, so nothing consults it through a second raw `process.env`
 * lookup with its own idea of what an absent value means.
 *
 * ─── Why the value is worth LOGGING ────────────────────────────────────────────────────────────────
 * It is unresolved — and consequential — whether Claude Code sets this to the PRIMARY clone or to the
 * linked WORKTREE an agent is working in, and everything known about it today is inference:
 *
 *   • The L1 binary never consults it for routing: hook-core takes `cwd` off the payload and resolves
 *     the repo root from THAT, so per-worktree state routing proves nothing either way.
 *   • The L0 sh shim is anchored to it — `.claude/settings.json` invokes
 *     `sh "$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh"` and the shim derives `$ROOT` from `$0`.
 *     So L0 measures version drift in whichever tree this names.
 *   • Indirect evidence for PRIMARY: an agent isolated in a worktree that has NO `node_modules` at all
 *     works normally. Were this the worktree, the shim would find no bin and fail closed on fault `X`
 *     for every single call.
 *   • Contradicting evidence: claude-code issue #36360 reports it resolving to a worktree path.
 *
 * A guard that MEASURES a fault in one tree while the cure has to run in another is precisely the bug
 * class the per-worktree log routing exists to expose, and it is invisible unless the line records
 * both this value AND the tree the guard actually acted in. So both go on every invocation line; when
 * they disagree, that divergence IS the bug signature.
 */
@injectable(bindingScopeValues.Singleton)
export class ClaudeEnv {
    /** The raw value, or null when the variable is absent. Never throws. */
    projectDir(): string | null {
        return process.env[CLAUDE_PROJECT_DIR_ENV] ?? null;
    }

    /**
     * The value as a log field: the raw string when set (INCLUDING an empty one, which prints as
     * nothing and is therefore distinguishable from…) or `<unset>` when the variable is absent.
     */
    projectDirForLog(): string {
        const value = this.projectDir();
        return value === null ? CLAUDE_PROJECT_DIR_UNSET : value;
    }
}

// Process-wide instance for the many non-DI call sites (hooks, wp-* bins); inversify still injects the
// singleton wherever a container is in play.
export const claudeEnv = new ClaudeEnv();
