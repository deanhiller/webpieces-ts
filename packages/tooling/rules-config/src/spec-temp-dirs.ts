import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { toError } from './to-error';

// ---------------------------------------------------------------------------
// ONE OWNER FOR EVERY `$TMPDIR` SCRATCH TREE THE TOOLING CREATES.
//
// THE DEFECT. Every `packages/tooling/**` spec builds its fixture with
// `specTempDirs.make('wp-<something>-')` and NONE of them removed it afterwards.
// Measured on one developer machine: 270,200 abandoned `wp-*` directories out of 286,270 total entries
// in `$TMPDIR` — 64,828 of them from `vitest.setup.mts` alone, which mints one isolated `$HOME` per test
// FILE per run. The cost is not disk (every `wp-*` prefix together is under 1 GiB; the `$HOME` dirs are
// empty by design) — it is INODES and the fact that `$TMPDIR` stops being inspectable: `ls` takes ~30s
// and `du` takes minutes, which is how this went unnoticed for as long as it did.
//
// WHY `$TMPDIR` AND NOT `.webpieces/`, WHICH IS WHERE EVERYTHING ELSE GOES. Because for a TEST fixture
// the whole point is to be outside the repo, and two separate mechanisms depend on that:
//   - `vitest.setup.mts` mints a throwaway `$HOME` so a spec cannot read the developer's real
//     `~/.webpieces/config.json`. A fake HOME inside the repo defeats its own isolation.
//   - The fixtures `git init` and `git worktree add` INSIDE themselves. A nested git repo under the real
//     repo root is what breaks the nx graph — the same hazard that makes `.claude/worktrees/` a
//     mandatory gitignore entry.
// So the location was never the bug. The missing cleanup was.
//
// WHO ACTUALLY CALLS `reapAll`, AND WHY IT IS NOT A LINE IN EACH SPEC. An `afterAll` written into each
// of the 212 call sites is a line somebody has to remember, forever, in every new spec — precisely the
// discipline already demonstrated not to hold here. Instead `vitest.setup.mts` calls `reapAll()` in ONE
// global `afterAll`, so a call site swaps `fs.mkdtempSync(...)` for `specTempDirs.make(...)` and there
// is no other half to forget.
//
// THE `exit` REAPER BELOW IS THE SECONDARY BELT, NOT THE PRIMARY ONE — and the first cut of this file
// had that backwards. It relied on `process.on('exit')` alone, and a 145-file tooling run then left
// exactly 145 `wp-vitest-home-` directories behind: a 100% miss. The cause is `pool: 'forks'` (see
// vitest.config.mts) — vitest KILLS its workers rather than letting them exit, and a killed process runs
// no exit handler. The handler stays because it costs one listener and does fire for the non-vitest
// callers (testkits driven from plain node scripts), but nothing here should depend on it.
//
// SO CLEANUP IS BEST-EFFORT BY CONSTRUCTION, at two levels: a worker killed mid-file skips the
// `afterAll` too. That residue is why `CleanTmp` sweeps aged `wp-*` out of `$TMPDIR` via
// `TmpScratchSweeper` — belt, braces, and a sweep for what both of them miss.
// ---------------------------------------------------------------------------

/**
 * Creates `$TMPDIR` scratch directories for specs and testkits, and reaps every one of them when the
 * process exits.
 *
 * Use the shared `specTempDirs` instance — the reaper is registered per-instance, so a caller that
 * constructs its own gets a second `exit` listener and no benefit.
 */
export class SpecTempDirs {
    private readonly created: string[] = [];
    private reaperRegistered = false;

    /**
     * `fs.mkdtempSync` under `os.tmpdir()`, with the path remembered for cleanup.
     *
     * `prefix` keeps the existing `wp-<area>-` convention so a leaked tree still names its creator; the
     * trailing dash matters because mkdtemp appends six random characters directly onto it.
     */
    make(prefix: string): string {
        this.registerReaper();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
        this.created.push(dir);
        return dir;
    }

    /**
     * `make`, with symlinks resolved.
     *
     * macOS hands back `/var/folders/...` from `os.tmpdir()` while `/var` is a symlink to `/private/var`,
     * so a fixture that compares a path it was given against one the code under test computed sees two
     * different strings for the same directory. Specs that do that comparison call this instead.
     */
    makeReal(prefix: string): string {
        return fs.realpathSync(this.make(prefix));
    }

    /**
     * Removes every directory this instance created, then forgets them.
     *
     * Deliberately never throws: it runs from an `exit` handler where a throw would replace a passing
     * test run's exit code with a crash, and a scratch directory that cannot be removed is a leak, not a
     * failure. Callers may also invoke it directly — a long suite that wants its fixtures gone before the
     * end of the run.
     */
    reapAll(): void {
        const dirs = this.created.splice(0, this.created.length);
        for (const dir of dirs) {
            // webpieces-disable no-unmanaged-exceptions -- chokepoint: this runs from vitest's afterAll and
            // from an exit handler, where a throw would turn a passing run into a crash over a scratch dir
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch (err: unknown) {
                const error = toError(err);
                process.stderr.write(`SpecTempDirs: could not remove ${dir}: ${error.message}\n`);
            }
        }
    }

    // One listener per instance, added lazily so a process that never makes a fixture never registers.
    private registerReaper(): void {
        if (this.reaperRegistered) return;
        this.reaperRegistered = true;
        process.on('exit', (): void => this.reapAll());
    }
}

// The shared instance — the reaper and the created-list are per-instance, so every caller must use this.
export const specTempDirs = new SpecTempDirs();
