/**
 * THE SETTINGS-FILE SHAPE — one declaration of it, in a LEAF module that imports nothing.
 *
 * MEASURED: Codex's `.codex/hooks.json` uses the IDENTICAL `hooks.<event>[].hooks[].command` shape as
 * Claude Code's `.claude/settings.json`, so one reader, one writer and one repair serve both files —
 * the difference between the harnesses is entirely in the VALUES (matcher, shim anchor), which is what
 * `HarnessRegistration` carries. The `env` block is Claude Code's alone.
 *
 * It sits in its own file because two modules need it and one of them, `hook-registration.ts`, imports
 * the repairs from the other, `neighbour-hooks.ts`. Declaring the shape in either one would close a file
 * import cycle — which `validate-no-file-import-cycles` fails the build on, and which is a genuine
 * hazard in this bin layer, where every module must still load on a tree too broken to build anything.
 * A leaf both can point at costs one file and removes the choice.
 */

// webpieces-disable no-any-unknown -- settings.json is opaque consumer JSON
export interface HookCommand { type: string; command: string; }

export interface HookEntry { matcher: string; hooks: HookCommand[]; }

/**
 * The `hooks` block, keyed by EVENT. `PreToolUse` is named because every webpieces-managed entry lives
 * there; the index signature is what lets the neighbour-anchoring pass reach `PostToolUse`, `Stop` and
 * everything else — a relative entry path fails to load under any event, so a repair scoped to one of
 * them would leave a half-fixed file and report success.
 */
export interface HookEvents {
    PreToolUse?: HookEntry[];
    [event: string]: HookEntry[] | undefined;
}

export interface ClaudeSettings {
    hooks?: HookEvents;
    // Claude Code's settings `env` block: every key is exported into the environment of the session AND
    // of every subagent it spawns. That inheritance is precisely why webpieces pins its managed entry
    // here rather than in a shell profile — see managed-env.ts.
    env?: Record<string, string>;
    // webpieces-disable no-any-unknown -- opaque settings bag; arbitrary keys allowed
    [key: string]: unknown;
}
