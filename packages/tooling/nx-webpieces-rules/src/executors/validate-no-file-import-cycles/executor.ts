/**
 * Validate No File Import Cycles Executor
 *
 * Per-project circular-dependency gate. Runs `madge` over the project's
 * TypeScript sources and fails when an import cycle is found.
 *
 * Unlike the old `nx:run-commands` target (which shelled out to a runtime
 * `npx madge` fetch — see NEEDED_CHANGES.md #1), this executor:
 *   - invokes the madge it bundles as a dependency (deterministic, no network),
 *   - is driven by webpieces.config.json like every other webpieces rule, so it
 *     supports an on/off `mode` and a time-boxed `ignoreModifiedUntilEpoch`.
 *
 * Config (webpieces.config.json, rule key `no-file-import-cycles`):
 *   "no-file-import-cycles": {
 *       "mode": "ON",                       // "OFF" disables the gate everywhere
 *       "ignoreModifiedUntilEpoch": 1771931925,  // epoch SECONDS; while now < epoch,
 *                                            //   cycles are reported but the gate PASSES
 *                                            //   (warn, don't fail). After it, fails again.
 *       "ignoreTypeOnly": true              // ignore `import type` re-export cycles
 *                                            //   (erased at compile time, harmless at runtime)
 *   }
 *
 * Mirrors the dated-disable model already used for the method/file-size rules:
 * the epoch is a grace window so a strict gate can be turned on against an
 * existing codebase without an open-ended "off everywhere" escape hatch.
 *
 * Usage: nx run <project>:validate-no-file-import-cycles
 */

import type { ExecutorContext } from '@nx/devkit';
import { loadConfig } from '@webpieces/rules-config';
import * as path from 'path';

export type ValidateNoFileImportCyclesMode = 'ON' | 'OFF';

export interface ValidateNoFileImportCyclesOptions {
    // No options here — config comes from webpieces.config.json at runtime.
}

export interface ExecutorResult {
    success: boolean;
}

const RULE_NAME = 'no-file-import-cycles';

// madge ships no type declarations; describe the slice of its API we use.
// webpieces-disable no-any-unknown -- minimal hand-typed surface for an untyped dependency
interface MadgeOptions {
    fileExtensions: string[];
    excludeRegExp?: string[];
    detectiveOptions?: Record<string, unknown>;
}
interface MadgeInstance {
    circular(): string[][];
}
type MadgeFn = (target: string, options: MadgeOptions) => Promise<MadgeInstance>;

// madge's CJS export is the callable itself; some bundlers wrap it under `.default`.
interface MadgeModuleExtras {
    default?: MadgeFn;
}
type MadgeModule = MadgeFn & MadgeModuleExtras;

function loadMadge(): MadgeFn {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod: MadgeModule = require('madge');
    return mod.default ?? mod;
}

/**
 * Decide whether the gate should still FAIL on cycles (true) or only warn
 * (false), considering the ignoreModifiedUntilEpoch grace window. Logs a
 * one-line explanation when the grace window is active.
 */
function isFailingActive(epoch: number | undefined): boolean {
    if (epoch === undefined) return true;
    const nowSeconds = Date.now() / 1000;
    if (nowSeconds < epoch) {
        const expires = new Date(epoch * 1000).toISOString().split('T')[0];
        console.log(
            `\n⏳ no-file-import-cycles: ignoreModifiedUntilEpoch active (expires ${expires}).` +
                '\n   Cycles will be reported but NOT fail the build until then.\n',
        );
        return false;
    }
    return true;
}

// Never scan build output or declaration files. A project that compiles into a
// local `dist/` (or build/out/coverage) would otherwise report cycles among the
// emitted `*.d.ts` files instead of — or in addition to — the real source
// cycles, so the gate would flag compiled-output noise and could diverge from a
// plain `madge src` run. Excluding these makes the gate scan source only.
const EXCLUDE_BUILD_DIRS = '(^|/)(node_modules|dist|build|out|coverage|\\.nx|\\.next)(/|$)';
const EXCLUDE_DECLARATION_FILES = '\\.d\\.ts$';

function buildMadgeOptions(ignoreTypeOnly: boolean): MadgeOptions {
    const options: MadgeOptions = {
        fileExtensions: ['ts', 'tsx'],
        excludeRegExp: [EXCLUDE_BUILD_DIRS, EXCLUDE_DECLARATION_FILES],
    };
    if (ignoreTypeOnly) {
        // dependency-tree's TS detective drops `import type {...}` edges with this flag.
        options.detectiveOptions = {
            ts: { skipTypeImports: true },
            tsx: { skipTypeImports: true },
        };
    }
    return options;
}

function reportCycles(projectName: string, cycles: string[][]): void {
    console.error(`\n❌ Found ${cycles.length} circular import cycle(s) in ${projectName}:\n`);
    cycles.forEach((cycle: string[], i: number) => {
        console.error(`  ${i + 1}. ${cycle.join(' → ')} → ${cycle[0]}`);
    });
    console.error('\nTo fix, break the cycle (extract a shared module, or use an interface).');
    console.error('To time-box a known cycle, a human can set "ignoreModifiedUntilEpoch"');
    console.error(`(epoch seconds) on the "${RULE_NAME}" rule in webpieces.config.json.`);
    console.error(`To turn the gate off entirely, set "${RULE_NAME}".mode to "OFF".\n`);
}

export default async function runExecutor(
    _options: ValidateNoFileImportCyclesOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    const shared = loadConfig(context.root);
    const rule = shared.rules.get(RULE_NAME);

    if (rule && rule.isOff) {
        console.log(`\n⏭️  Skipping ${RULE_NAME} (mode: OFF)\n`);
        return { success: true };
    }

    const projectName = context.projectName ?? 'project';
    const projectConfig = context.projectsConfigurations?.projects[projectName];
    const projectRoot = projectConfig ? path.join(context.root, projectConfig.root) : context.root;

    const epoch = rule?.options['ignoreModifiedUntilEpoch'] as number | undefined;
    const ignoreTypeOnly = (rule?.options['ignoreTypeOnly'] as boolean | undefined) ?? false;

    console.log(`\n🔁 Checking import cycles in ${projectName} (madge)\n`);

    const madge = loadMadge();
    const result = await madge(projectRoot, buildMadgeOptions(ignoreTypeOnly));
    const cycles = result.circular();

    if (cycles.length === 0) {
        console.log('✅ No circular import cycles found\n');
        return { success: true };
    }

    reportCycles(projectName, cycles);

    // Grace window active → report but pass; otherwise fail.
    return { success: !isFailingActive(epoch) };
}
