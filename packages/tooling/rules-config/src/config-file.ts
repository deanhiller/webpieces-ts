import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { InformAiError } from './inform-ai-error';
import { toError } from './to-error';

export const CONFIG_FILENAME = 'webpieces.config.json';

/**
 * How many times a read+parse of webpieces.config.json is attempted before the failure is treated as
 * REAL. On a machine running several agents at once the file is routinely rewritten underneath us
 * (a dep bump, another worktree's `wp-*` command, an editor's write-then-rename), and for the few
 * milliseconds of that write the bytes on disk are a truncated/half-written JSON document. Reading
 * exactly then produced a hard block that self-healed seconds later — a false positive that also
 * blocked the tools needed to look into it. Three attempts spanning ~50ms covers a normal write with
 * a cost no human or agent can perceive, and cannot mask a file that is genuinely malformed (a
 * conflict-marked or typo'd config fails all three, identically, and still blocks).
 */
export const CONFIG_PARSE_ATTEMPTS = 3;

/** Pause between parse attempts. Small enough to be invisible, long enough to outlast a file write. */
export const CONFIG_PARSE_RETRY_MILLIS = 25;

/**
 * One read+parse attempt: EITHER a parsed config OR the error that attempt hit, never both.
 * Data-only (per CLAUDE.md, classes for data).
 */
export class ConfigParseAttempt {
    constructor(
        readonly config: RawConfigFile | null,
        readonly error: Error | null,
    ) {}
}

// Raw shape of webpieces.config.json as parsed from JSON, before validation/typing.
//  - `rules`      — code-style validators (scope edit/file).
//  - `hookGuards` — git/PR/branch protection guards (scope bash).
//  - `commands`   — gated command config the guards point at; `pr-gate` lives inside it. Carried as
//                   opaque JSON because its nested `gates` array can't be expressed in the FieldDef
//                   schema; validated structurally by validateCommandsSection.
//  - `pr-gate`    — DEPRECATED top-level block (pre-migration layout). Read only as a back-compat
//                   fallback / to emit a "move it under commands" migration error.
// webpieces-disable no-any-unknown -- consumer JSON config has opaque rule option values
export interface RawConfigFile {
    extends?: string;
    rules?: Record<string, Record<string, unknown>>;
    hookGuards?: Record<string, Record<string, unknown>>;
    // webpieces-disable no-any-unknown -- opaque commands JSON, validated by validateCommandsSection
    commands?: unknown;
    // REQUIRED top-level block: two glob lists that suppress hook enforcement per file path.
    // Opaque here (validated structurally by validateExcludePaths, then parsed into ExcludePaths).
    // webpieces-disable no-any-unknown -- opaque excludePaths JSON, validated by validateExcludePaths
    excludePaths?: unknown;
    // REQUIRED top-level array of client-authored content guards (regex patterns + message + scoping).
    // Opaque here; validated structurally by validateMatchRulesSection, then parsed into MatchRuleConfig[].
    // webpieces-disable no-any-unknown -- opaque match-rules JSON, validated by validateMatchRulesSection
    'match-rules'?: unknown;
    rulesDir?: string[];
    // webpieces-disable no-any-unknown -- DEPRECATED top-level pr-gate, migrated under `commands`
    'pr-gate'?: unknown;
}

/**
 * Locates + reads webpieces.config.json. `@injectable(bindingScopeValues.Singleton)` so it can be injected into the config
 * loader and appear in the rules-config DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class ConfigFile {
    /** Walk up from `startDir` looking for webpieces.config.json. Returns its absolute path or null. */
    findConfigFile(startDir: string): string | null {
        let dir = startDir;
        while (true) {
            const primary = path.join(dir, CONFIG_FILENAME);
            if (fs.existsSync(primary)) return primary;
            const parent = path.dirname(dir);
            if (parent === dir) return null;
            dir = parent;
        }
    }

    /**
     * Read + JSON.parse webpieces.config.json, RETRYING a failed attempt before escalating.
     *
     * A single failed read is not evidence of a broken config: another process on this machine may be
     * mid-write, and a half-written file is unparseable for a few milliseconds and then fine. Only a
     * failure that survives every attempt is treated as real — and then it still throws, so a
     * genuinely invalid config blocks exactly as before. See {@link CONFIG_PARSE_ATTEMPTS}.
     */
    readRawConfig(configPath: string): RawConfigFile {
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= CONFIG_PARSE_ATTEMPTS; attempt++) {
            if (attempt > 1) this.sleepSync(CONFIG_PARSE_RETRY_MILLIS);
            const outcome = this.attemptReadAndParse(configPath);
            if (outcome.config !== null) return outcome.config;
            lastError = outcome.error;
        }
        throw new InformAiError(this.formatParseFailure(configPath, lastError));
    }

    // ONE read+parse attempt. The read is inside the try too: a file being replaced can momentarily
    // fail to open (ENOENT between unlink and rename), which is the same transient class as a
    // half-written parse failure and must be retried the same way.
    private attemptReadAndParse(configPath: string): ConfigParseAttempt {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const raw = this.readFileText(configPath);
            return new ConfigParseAttempt(JSON.parse(raw) as RawConfigFile, null);
        } catch (err: unknown) {
            const error = toError(err);
            return new ConfigParseAttempt(null, error);
        }
    }

    /** Read the file's bytes. `protected` so a test can inject a transient failure deterministically. */
    protected readFileText(configPath: string): string {
        return fs.readFileSync(configPath, 'utf8');
    }

    /**
     * Block this thread for `millis`. The hook path is synchronous top to bottom (a PreToolUse hook
     * answers on stdout before the tool runs), so an async delay is not available; `Atomics.wait` on a
     * never-notified word is the standard dependency-free synchronous sleep.
     */
    protected sleepSync(millis: number): void {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, millis);
    }

    // The AI-facing message for a parse failure that survived every attempt. It names the retry count
    // on purpose: an agent that sees "invalid JSON" for a file that reads fine three seconds later has
    // no way to tell a race from a real syntax error, and the FIRST thing it needs to know is that
    // read-only inspection of the file is still available so it can go look.
    private formatParseFailure(configPath: string, error: Error | null): string {
        return (
            `webpieces.config.json could not be parsed as JSON — retried ${CONFIG_PARSE_ATTEMPTS} times ` +
            `over ~${CONFIG_PARSE_RETRY_MILLIS * (CONFIG_PARSE_ATTEMPTS - 1)}ms and it failed every time.\n` +
            `Parse error: ${error?.message ?? 'unknown'}\n` +
            `File: ${configPath}\n\n` +
            `Two causes, in the order to check them:\n` +
            `  1. GENUINELY INVALID — most likely. Look at the file: a trailing comma, a missing brace, ` +
            `or leftover conflict markers (\`<<<<<<< HEAD\`) from a merge you are in the middle of.\n` +
            `  2. STILL BEING WRITTEN by another process (another agent/worktree on this machine, a dep ` +
            `bump, an editor save). ${CONFIG_PARSE_ATTEMPTS} attempts already ruled out a brief write, but a ` +
            `long-running writer can outlast them — if so, simply retrying your command now will succeed.\n\n` +
            `👉 READING AND EDITING ${CONFIG_FILENAME} IS ALWAYS ALLOWED, including right now: \`Read\`, ` +
            `\`cat\`, \`grep\`, \`sed -n\` and the other read-only inspection commands still work while the ` +
            `config is broken. Go look at the file, fix it, then retry. (Writes to OTHER files stay ` +
            `blocked — with an unparseable config every guard is disabled, so nothing else may proceed.)`
        );
    }
}

// Temporary migration delegators — consumers migrate to injecting ConfigFile over follow-up PRs, then
// these free functions are removed. Declarations kept identical to the originals (unchanged lines).
const configFileSvc = new ConfigFile();

/**
 * Walk up from `startDir` looking for webpieces.config.json. Returns its absolute path or null.
 */
export function findConfigFile(startDir: string): string | null {
    return configFileSvc.findConfigFile(startDir);
}

/**
 * Read + JSON.parse webpieces.config.json, surfacing parse failures as a readable InformAiError.
 */
export function readRawConfig(configPath: string): RawConfigFile {
    return configFileSvc.readRawConfig(configPath);
}
