#!/usr/bin/env node
import { healShim, findShimRoot, RECOVERY_CMD } from './shim';
import { toError } from '../core/to-error';

// ---------------------------------------------------------------------------
// The `wp-install-ai-hooks` entry point, deliberately kept FREE of heavy imports.
//
// THE BUG THIS FIXES — the installer was a victim of the very corruption it must repair.
// setup.ts top-level-imports @webpieces/rules-config, which imports minimatch. When node_modules is
// corrupt — a package half-written by an install that was killed mid-copy — node dies at REQUIRE time
// with MODULE_NOT_FOUND, before a single line of the installer runs. So `pnpm wp-install-ai-hooks` —
// the one command that can rewrite the fail-closed shim — died with a raw 30-line node loader trace
// and repaired nothing. Worse, `pnpm install` cannot heal that corruption either (pnpm sees the right
// version on disk, considers the package installed, and skips it), so the repo was wedged: guards
// down, installer unable to reinstall them, and the only signal an unreadable stack trace.
//
// The seam: ./shim imports NOTHING but fs and path. Writing the shim never needed the rule engine.
// So do the repair FIRST with the dependency-free module, and only then reach for setup.ts:
//
//   1. healShim(cwd)      — refresh the committed shim. Works on a corrupt tree. This re-arms the
//                           fail-closed gate, so guards-being-down becomes LOUD instead of silent.
//   2. require('./setup') — the full install (config seeding, settings.json wiring). Needs the rule
//                           engine, so it loads LAZILY: a corrupt tree can no longer preempt step 1.
//   3. MODULE_NOT_FOUND   — print the one command that actually repairs it, not a node stack.
// ---------------------------------------------------------------------------

// ANSI red — the recovery command is the whole point of this message, so it must not scroll past
// unnoticed the way the old loader trace did.
const RED = '[31;1m';
const RESET = '[0m';

// The human-facing recovery notice, printed to stderr INSTEAD of a raw node loader trace. Mirrors the
// shim's deny reason so the terminal and the AI tell the human the same story.
// webpieces-disable no-function-outside-class -- bin entry point: this module MUST load with only fs+path (see header). A DI-managed class would pull the container in and reintroduce the exact require-time crash being fixed.
export function recoveryNotice(detail: string, shimRefreshed: boolean): string[] {
    const lines = [
        `${RED}🛑 @webpieces: cannot run the installer — your node_modules is corrupt.${RESET}`,
        '',
        `  ${detail}`,
        '',
        '  A package is only partially written on disk (usually an install that was killed mid-copy).',
        '  A plain `pnpm install` will NOT fix it: pnpm sees the correct version in the package.json',
        '  already on disk, considers the package installed, and skips it.',
        '',
        `${RED}  Run exactly this, then retry:${RESET}`,
        `${RED}    ${RECOVERY_CMD}${RESET}`,
        '',
    ];
    if (shimRefreshed) {
        // The important half of the job still got done: the fail-closed gate is current, so the AI is
        // BLOCKED (citing this same command) rather than silently editing behind dead guards.
        lines.push('  The AI guard shim WAS refreshed, so tool calls are now BLOCKED until you repair the');
        lines.push('  tree. That is intentional — it is what stops the AI from working unguarded.');
    } else {
        lines.push('  No committed shim was found to refresh. Re-run this installer after the repair.');
    }
    return lines;
}

// Node stamps a `code` onto require() failures, which the base Error type does not carry.
class NodeRequireError extends Error {
    readonly code?: string;
}

// The lazily-required ./setup module. Named (not an inline literal) so the require cast stays typed.
class SetupModule {
    main!: () => Promise<void>;
}

// A require() failure from a corrupt / partially-written node_modules. Node reports a missing relative
// specifier ('./assert-valid-pattern.js' — a package's own file absent from disk) and a missing bare
// specifier ('@webpieces/rules-config' — package not installed at all) with the SAME code. Both mean a
// broken tree from the installer's point of view, and both have the same cure, so both map to true.
// webpieces-disable no-function-outside-class -- bin entry point: this module MUST load with only fs+path (see header). A DI-managed class would pull the container in and reintroduce the exact require-time crash being fixed.
export function isBrokenTreeError(error: Error): boolean {
    return (error as NodeRequireError).code === 'MODULE_NOT_FOUND';
}

// Returns the process exit code (0 = ok). Kept as a function (not top-level code) so it is unit-
// testable without spawning node.
// webpieces-disable no-function-outside-class -- bin entry point: this module MUST load with only fs+path (see header). A DI-managed class would pull the container in and reintroduce the exact require-time crash being fixed.
export async function runInstaller(cwd: string): Promise<number> {
    // STEP 1 — re-arm the fail-closed gate FIRST, via the dependency-free module. healShim never
    // throws and only rewrites a shim that ALREADY exists, so a global install is left untouched.
    const shimRefreshed = findShimRoot(cwd) !== null;
    healShim(cwd);

    // STEP 2 — the real install, loaded LAZILY ON PURPOSE. A static import would drag
    // @webpieces/rules-config → minimatch in at module-load time and a corrupt tree would kill this
    // file before step 1 ever ran — which is precisely the failure being fixed here. Do not hoist it.
    // webpieces-disable no-unmanaged-exceptions -- this IS the top-level chokepoint: the bin entry. It exists to turn a raw MODULE_NOT_FOUND loader trace into an actionable recovery message; a real bug is re-thrown untouched.
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const setup = require('./setup') as SetupModule;
        await setup.main();
        return 0;
    } catch (err: unknown) {
        const error = toError(err);
        if (!isBrokenTreeError(error)) throw error;   // a real bug — never hide it behind a nice message
        for (const line of recoveryNotice(error.message.split('\n')[0], shimRefreshed)) console.error(line);
        return 1;
    }
}

/**
 * THE PROCESS ENTRY POINT — absent from every release up to and including 0.4.588, exactly as it was
 * absent from upgrade-shim.ts. `pnpm exec wp-install-ai-hooks` loaded this module, defined
 * `isBrokenTreeError` and `runInstaller`, and exited 0 without installing anything: the shim was never
 * healed, `./setup` was never required, and the "broken tree" recovery notice this file exists to print
 * could never be reached. Verified against the published 0.4.576 artifact — `node
 * node_modules/@webpieces/ai-hook-rules/src/bin/install-entry.js` produced no output and exit 0.
 *
 * `runMain` from @webpieces/rules-config is deliberately NOT used: this module must load with fs+path
 * only (see the header) so it survives the corrupt node_modules it is meant to recover from, and
 * importing the wrapper would reintroduce the require-time crash. `main()` is the sanctioned single
 * exit site instead, and `install-entry-process.spec.ts` SPAWNS this file so the launcher cannot be
 * dropped again without a red test.
 */
// webpieces-disable no-function-outside-class -- bin entry point: this module MUST load with only fs+path (see header). A DI-managed class would pull the container in and reintroduce the exact require-time crash being fixed.
export async function main(): Promise<void> {
    process.exit(await runInstaller(process.cwd()));
}

if (require.main === module) {
    void main();
}
