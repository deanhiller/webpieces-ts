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
 *       "ignoreTypeOnly": true,             // ignore `import type` re-export cycles
 *                                            //   (erased at compile time, harmless at runtime)
 *       "excludePackages": ["@kami/entities"] // npm package names whose source trees madge
 *                                            //   should NOT traverse (stops foreign cycles
 *                                            //   from leaking into this project's report)
 *   }
 *
 * Mirrors the dated-disable model already used for the method/file-size rules:
 * the epoch is a grace window so a strict gate can be turned on against an
 * existing codebase without an open-ended "off everywhere" escape hatch.
 *
 * Usage: nx run <project>:validate-no-file-import-cycles
 */

import type { ExecutorContext } from '@nx/devkit';
import { loadAndValidate, shouldSkipRule } from '@webpieces/rules-config';
import * as fs from 'fs';
import * as path from 'path';
import { toError } from '../../toError';

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
 * (false), considering the universal escape hatches: the ignoreModifiedUntilEpoch
 * grace window and ignoreRuleWhileOnBranch. Logs a one-line explanation when a
 * hatch is active.
 */
function isFailingActive(epoch: number | undefined, branch: string | undefined): boolean {
    const skip = shouldSkipRule(epoch, branch);
    if (skip.skip) {
        console.log(
            `\n⏳ no-file-import-cycles: ${skip.reason}.` +
                '\n   Cycles will be reported but NOT fail the build.\n',
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

function escapeRegex(s: string): string {
    return s.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

class TsconfigCompilerOptions {
    paths?: Record<string, string[]>;
}
class TsconfigBase {
    compilerOptions?: TsconfigCompilerOptions;
}

/** Read tsconfig.base.json compilerOptions.paths from the workspace root, or null on failure. */
function readTsconfigPaths(workspaceRoot: string): Record<string, string[]> | null {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- best-effort read; null on any failure
    try {
        const tsconfigPath = path.join(workspaceRoot, 'tsconfig.base.json');
        const content = fs.readFileSync(tsconfigPath, 'utf8');
        const tsconfig = JSON.parse(content) as TsconfigBase;
        return tsconfig?.compilerOptions?.paths ?? null;
    // webpieces-disable catch-error-pattern -- file missing or malformed JSON; caller handles null
    } catch (err: unknown) {
        //const error = toError(err);
        return null;
    }
}

/**
 * Walk up from startPath to find the nearest ancestor directory that contains
 * a package.json. Returns that directory path, or null if none found.
 */
function findPackageRoot(startPath: string): string | null {
    let dir = fs.statSync(startPath).isDirectory() ? startPath : path.dirname(startPath);
    const fsRoot = path.parse(dir).root;
    while (dir !== fsRoot) {
        if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
        dir = path.dirname(dir);
    }
    return null;
}

function resolvePackageDir(pkgName: string, workspaceRoot: string): string | null {
    // First try require.resolve (works for installed / symlinked packages).
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- resolution failure is expected; fall through to tsconfig path lookup
    try {
        const pkgJson = require.resolve(`${pkgName}/package.json`, { paths: [workspaceRoot] });
        return fs.realpathSync(path.dirname(pkgJson));
    // webpieces-disable catch-error-pattern -- expected for non-installed packages; fall through to tsconfig path lookup
    } catch (err: unknown) {
        //const error = toError(err);
        // Fall through to tsconfig path resolution for pnpm workspace packages.
    }

    // Fallback: resolve via tsconfig.base.json compilerOptions.paths.
    // pnpm workspace packages are not in node_modules, so require.resolve fails above;
    // tsconfig.base.json maps e.g. "@mealco-internal/kami" → ["libraries/kami/index.ts"].
    const tsconfigPaths = readTsconfigPaths(workspaceRoot);
    const entries = tsconfigPaths?.[pkgName];
    if (!entries || entries.length === 0) {
        console.warn(
            `⚠️  no-file-import-cycles: could not resolve excludePackages entry "${pkgName}"` +
                ` — not found in node_modules or tsconfig.base.json paths. Skipping.`,
        );
        return null;
    }
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- best-effort fallback; warn on any failure
    try {
        const resolved = path.resolve(workspaceRoot, entries[0]);
        const pkgRoot = findPackageRoot(resolved);
        if (!pkgRoot) {
            console.warn(
                `⚠️  no-file-import-cycles: resolved "${pkgName}" → "${resolved}"` +
                    ` but found no package.json in parent directories — skipping.`,
            );
            return null;
        }
        return pkgRoot;
    } catch (err: unknown) {
        const error = toError(err);
        console.warn(
            `⚠️  no-file-import-cycles: could not resolve excludePackages entry "${pkgName}"` +
                ` via tsconfig paths (${error.message}) — skipping.`,
        );
        return null;
    }
}

function buildMadgeOptions(ignoreTypeOnly: boolean, excludePackages: string[], workspaceRoot: string): MadgeOptions {
    const excludeRegExp = [EXCLUDE_BUILD_DIRS, EXCLUDE_DECLARATION_FILES];
    for (const pkg of excludePackages) {
        const dir = resolvePackageDir(pkg, workspaceRoot);
        if (dir) excludeRegExp.push(`^${escapeRegex(dir)}(/|$)`);
    }
    const options: MadgeOptions = {
        fileExtensions: ['ts', 'tsx'],
        excludeRegExp,
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
    const shared = loadAndValidate(context.root).resolved;
    const rule = shared.rules.get(RULE_NAME);

    if (rule && rule.isOff) {
        console.log(`\n⏭️  Skipping ${RULE_NAME} (mode: OFF)\n`);
        return { success: true };
    }

    const projectName = context.projectName ?? 'project';
    const projectConfig = context.projectsConfigurations?.projects[projectName];
    const projectRoot = projectConfig ? path.join(context.root, projectConfig.root) : context.root;

    const epoch = rule?.options['ignoreModifiedUntilEpoch'] as number | undefined;
    const branch = rule?.options['ignoreRuleWhileOnBranch'] as string | undefined;
    const ignoreTypeOnly = (rule?.options['ignoreTypeOnly'] as boolean | undefined) ?? false;
    const excludePackages = (rule?.options['excludePackages'] as string[] | undefined) ?? [];

    console.log(`\n🔁 Checking import cycles in ${projectName} (madge)\n`);

    const madge = loadMadge();
    const result = await madge(projectRoot, buildMadgeOptions(ignoreTypeOnly, excludePackages, context.root));
    const cycles = result.circular();

    if (cycles.length === 0) {
        console.log('✅ No circular import cycles found\n');
        return { success: true };
    }

    reportCycles(projectName, cycles);

    // Grace window or branch hatch active → report but pass; otherwise fail.
    return { success: !isFailingActive(epoch, branch) };
}
