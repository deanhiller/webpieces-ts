import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { renderShim, shimPath, SHIM_MARKER } from './shim';
import { managedEntries, readSettings, writeSettings } from './hook-registration';

/**
 * DOES THE BIN DO ANYTHING WHEN SPAWNED — the question twenty-one green unit tests never asked.
 *
 * `wp-upgrade-shim` and `wp-install-ai-hooks` shipped for many releases as SILENT NO-OPS: both modules
 * defined their `run*()` function and then ENDED. Node loaded the file, evaluated two function
 * declarations, and exited 0 with no output and no file touched. Verified against the published
 * artifacts 0.4.576 and 0.4.588 (`node node_modules/@webpieces/ai-hook-rules/src/bin/upgrade-shim.js`
 * → no stdout, status 0). `wp-upgrade-shim` is the cure fault S names as OPTION 1 while it blocks every
 * tool call, so an inert OPTION 1 plus an OPTION 2 that repairs ONE of the managed surfaces is a hard
 * deadlock in a consumer repo.
 *
 * Every existing spec missed it because they all `import { runUpgradeShim }` and call it as a FUNCTION.
 * That can never observe a missing launcher. These tests spawn a PROCESS instead.
 *
 * WHAT THIS PROVES, precisely:
 *  - `binsDeclareALauncher` reads the REAL `publishConfig.bin` maps of every tooling package, maps each
 *    published `.js` target back to its `.ts` source, and asserts the source carries a
 *    `require.main === module` launcher. It covers all 18 declared bins and is the regression net for
 *    any bin added later. It is a source-shape assertion, so it does NOT prove the launcher runs.
 *  - the spawn tests below COMPILE the bin with the real `tsc` (rootDir `src/`, so the whole import
 *    graph is emitted exactly as the published package emits it) and then run the emitted `.js` with
 *    `node`, which is byte-for-byte the thing npm ships and `node_modules/.bin` links. This is the only
 *    level at which the bug was visible.
 *
 * WHAT IT DOES NOT PROVE: nothing about `publish-packages.sh`'s bin hoist (covered by
 * `bin-targets-exist.spec.ts`), and the install-entry test stubs the lazily-required `./setup` module
 * (see its comment) so it proves the launcher fires and reaches the install, not what the installer does.
 */

const PKG_ROOT = path.resolve(__dirname, '..', '..');          // packages/tooling/ai-hook-rules
const TOOLING = path.resolve(PKG_ROOT, '..');                  // packages/tooling
const REPO_ROOT = path.resolve(TOOLING, '..', '..');

// Compiled output lands at the REPO ROOT on purpose. Node resolves `@webpieces/rules-config` (a real
// transitive import of ./shim) by walking UP from the file it runs, and it must land on the ROOT
// `node_modules/@webpieces/rules-config` — the PUBLISHED, already-compiled copy, which is what a
// consumer's tree looks like. Compiling under `packages/tooling/ai-hook-rules/` instead hits that
// package's own `node_modules/@webpieces/rules-config`, a pnpm `workspace:` symlink into SOURCE where
// `src/index.js` does not exist until tsc runs — MODULE_NOT_FOUND, and nothing to do with the bug.
// A dir under os.tmpdir() would resolve nothing at all.
const OUT_DIR = path.join(REPO_ROOT, `.spec-compiled-bins`);

function compileBin(entry: string): string {
    const tsc = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsc');
    const result = spawnSync(tsc, [
        entry,
        '--outDir', OUT_DIR,
        '--rootDir', path.join(PKG_ROOT, 'src'),
        '--module', 'commonjs', '--target', 'es2022', '--moduleResolution', 'node',
        '--esModuleInterop', '--skipLibCheck', '--sourceMap', 'false',
    ], { encoding: 'utf8', cwd: REPO_ROOT });
    // tsc emits even when it reports type errors (noEmitOnError is off), and the entry we care about is
    // type-checked for real by the package build. Only a MISSING emit is fatal here.
    const emitted = path.join(OUT_DIR, 'bin', `${path.basename(entry, '.ts')}.js`);
    if (!fs.existsSync(emitted)) throw new Error(`tsc emitted nothing for ${entry}:\n${result.stdout}\n${result.stderr}`);
    return emitted;
}

/** A temp tree that already carries a MANAGED (but reverted) shim — the state fault S blocks on. */
function stageDriftedRepo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-bin-proc-'));
    const target = shimPath(root);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '# hand-edited junk\n');
    // A settings.json on the OLD two-absolute-hook form, so the registration surface is drifted too and
    // the child has more than the shim to repair.
    writeSettings(path.join(root, '.claude', 'settings.json'), {
        hooks: {
            PreToolUse: [
                { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: `sh "$CLAUDE_PROJECT_DIR/${SHIM_MARKER}" wp-ai-rules-hook` }] },
                { matcher: 'Write|Edit|MultiEdit|Bash|Read', hooks: [{ type: 'command', command: `sh "$CLAUDE_PROJECT_DIR/${SHIM_MARKER}" wp-ai-guards-hook` }] },
            ],
        },
    });
    return root;
}

// findShimRoot falls back to $CLAUDE_PROJECT_DIR; under Claude Code that names the REAL repo, whose
// shim a temp-tree test must never touch. Cleared for every spawned child.
function childEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env['CLAUDE_PROJECT_DIR'];
    return env;
}

describe('every declared bin has a process launcher', () => {
    const packagesWithBins = ['ai-hook-rules', 'code-rules', 'pr-gate', 'nx-webpieces-rules'];

    it('maps every publishConfig.bin target back to a source file carrying `require.main === module`', () => {
        const missing: string[] = [];
        let checked = 0;
        for (const pkg of packagesWithBins) {
            const manifestPath = path.join(TOOLING, pkg, 'package.json');
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
                bin?: Record<string, string>;
                publishConfig?: { bin?: Record<string, string> };
            };
            // A top-level `bin` is itself banned here (see `.claude/rules/packaging-and-bins.md`), but if one
            // ever appears it must
            // still launch something, so both maps are audited.
            const bins = { ...(manifest.publishConfig?.bin ?? {}), ...(manifest.bin ?? {}) };
            for (const [name, target] of Object.entries(bins)) {
                const source = path.join(TOOLING, pkg, target.replace(/^\.\//, '').replace(/\.js$/, '.ts'));
                expect(fs.existsSync(source), `${name} -> ${source}`).toBe(true);
                const text = fs.readFileSync(source, 'utf8');
                checked++;
                // The launcher spellings actually in use across the tooling packages: the
                // dependency-free `require.main === module` guard (ai-hook-rules bins, which may not
                // import @webpieces/rules-config), a top-level `runMain(...)` (pr-gate's scripts), and a
                // top-level `main()` / `void main()` (code-rules). Anything else is presumed missing —
                // a new bin should copy one of these, not invent a fourth.
                const launched = /require\.main\s*===\s*module/.test(text)
                    || /^\s*(void\s+)?runMain\(/m.test(text)
                    || /^\s*(void\s+)?main\(\);/m.test(text);
                if (!launched) missing.push(`${pkg}:${name} (${target})`);
            }
        }
        expect(checked).toBeGreaterThanOrEqual(17);   // ai-hook-rules 4 + code-rules 2 + pr-gate 10 + nx 1
        expect(missing).toEqual([]);
    });
});

describe('wp-upgrade-shim, spawned as a process', () => {
    let compiled = '';
    beforeAll(() => { compiled = compileBin(path.join(PKG_ROOT, 'src', 'bin', 'upgrade-shim.ts')); }, 120_000);
    afterAll(() => { fs.rmSync(OUT_DIR, { recursive: true, force: true }); });

    it('repairs every managed surface, says so on stdout, and exits 0', () => {
        const root = stageDriftedRepo();
        const run = spawnSync(process.execPath, [compiled], { cwd: root, encoding: 'utf8', env: childEnv() });

        // (a) it is NOT silent — the whole defect was an empty stdout that read as success.
        expect(run.stdout.trim().length).toBeGreaterThan(0);
        expect(run.stdout).toContain('regenerated the managed shim');
        // (b) the files really changed on disk, in the child process, not in ours.
        expect(fs.readFileSync(shimPath(root), 'utf8')).toBe(renderShim());
        expect(managedEntries(readSettings(path.join(root, '.claude', 'settings.json'))).length).toBeGreaterThan(0);
        // (c) exit code 0 only on a verified repair.
        expect(run.status, run.stderr).toBe(0);

        fs.rmSync(root, { recursive: true, force: true });
    });

    it('exits NON-ZERO and explains when there is no managed shim to repair', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-bin-proc-none-'));
        const run = spawnSync(process.execPath, [compiled], { cwd: root, encoding: 'utf8', env: childEnv() });

        expect(run.status).toBe(1);
        expect(run.stderr).toContain('no committed');
        expect(fs.existsSync(shimPath(root))).toBe(false);   // it must not invent one
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('exits NON-ZERO when a surface is still drifted after the repair ran', () => {
        const root = stageDriftedRepo();
        // Make the repair unable to stick: the shim path is a DIRECTORY, so writeFileSync fails.
        // (The point is that a failed repair can never report success — the exact property that was
        // missing when a no-op returned 0.)
        fs.rmSync(shimPath(root));
        fs.mkdirSync(shimPath(root));
        const run = spawnSync(process.execPath, [compiled], { cwd: root, encoding: 'utf8', env: childEnv() });

        expect(run.status).not.toBe(0);
        expect(run.stdout + run.stderr).toContain('@webpieces');
        fs.rmSync(root, { recursive: true, force: true });
    });
});

describe('wp-install-ai-hooks, spawned as a process', () => {
    let compiled = '';
    beforeAll(() => { compiled = compileBin(path.join(PKG_ROOT, 'src', 'bin', 'install-entry.ts')); }, 120_000);
    afterAll(() => { fs.rmSync(OUT_DIR, { recursive: true, force: true }); });

    it('runs STEP 1 (heals the shim) and reaches STEP 2 (the install) when spawned', () => {
        // ./setup is required LAZILY by design, so the compiled tree lets us swap it for a stub. That
        // keeps this test about the LAUNCHER — the real setup is interactive (it prompts for a hook
        // target) and would hang a spawned child. What is proven: the module executes on spawn, heals
        // the committed shim first, then invokes setup.main(). What is NOT proven: anything the real
        // installer does — setup.spec.ts owns that.
        fs.writeFileSync(path.join(OUT_DIR, 'bin', 'setup.js'),
            'exports.main = async () => { console.log("SETUP-MAIN-RAN"); };\n');

        const root = stageDriftedRepo();
        const run = spawnSync(process.execPath, [compiled], { cwd: root, encoding: 'utf8', env: childEnv() });

        expect(run.stdout).toContain('SETUP-MAIN-RAN');
        expect(fs.readFileSync(shimPath(root), 'utf8')).toBe(renderShim());   // healShim ran before it
        expect(run.status, run.stderr).toBe(0);

        fs.rmSync(root, { recursive: true, force: true });
    });
});
