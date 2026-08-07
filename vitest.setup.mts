import { expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Per-file timeout budget: the `packages/tooling/**` suites get 120s, everything else keeps the 45s
 * global from vitest.config.mts.
 *
 * ─── Why a whole class of files, not a per-file annotation ──────────────────────────────────────────
 * The tooling suites are integration tests of git-driven and script-driven code paths, so they SPAWN
 * processes — `git init`, `git worktree add`, `npm publish` into a fake shim, POSIX `sh` guards. Per the
 * cost model in vitest.config.mts, a spawn from inside a vitest worker costs ~195ms even for a bare
 * `echo` (2.6ms from plain node), and `execSync`/`spawnSync` BLOCK the worker's event loop while they
 * run. So their wall-clock is dominated by spawn COUNT and by whatever else is competing for the box —
 * not by the work under test.
 *
 * That competition is structural, not accidental: `wp-ci` runs `nx affected --target=ci`, nx runs
 * several PROJECTS concurrently, and each project's vitest forks its own worker pool on top. One suite
 * was measured at 810s on a developer machine under that load.
 *
 * MEASURED, same commit, same test, minutes apart:
 *
 *   | spec                              | test                            | idle    | under a full run |
 *   |-----------------------------------|---------------------------------|---------|------------------|
 *   | publish-packages.spec.ts          | retries a transient failure     |   956ms | timed out (>45s) |
 *   | publish-packages.spec.ts          | summary naming both halves      | 93477ms | —                |
 *   | branch-creation-guard.e2e.spec.ts | (whole file, fixture in hook)   | 46000ms | timed out (>45s) |
 *   | checklist-scanner (pr-gate)       | —                               |       — | timed out (>45s) |
 *
 * Two orders of magnitude on the SAME test. Three different specs across three different packages have
 * now hit it independently, which is what makes this a class problem: annotating each offender as it
 * surfaces means re-diagnosing the same non-obvious failure every time a new one crosses the line.
 *
 * ─── Why a timeout and not a fix for the contention ────────────────────────────────────────────────
 * Both obvious levers were already tried and are recorded as rejected in vitest.config.mts: `maxForks:1`
 * measured 0 failures once and 26 the next run at higher load ("not a fix, just a wider margin"), and
 * `pool: 'threads'` moved the spawn floor by 12ms. Nor is there per-spawn waste left to remove in the
 * worst offenders — `publish-packages.spec.ts` runs the real release script, so its ~28 `npm publish`
 * spawns ARE the artifact under test and cannot be batched the way ShimTestkit batched greps.
 *
 * ─── Why 120s, and why this does not hide hangs ────────────────────────────────────────────────────
 * From the worst MEASURED time (93.5s) plus headroom — deliberately not "double the default to 90s",
 * which would still have failed that observation. It costs nothing on the happy path: a passing tooling
 * suite finishes in seconds and never touches the ceiling. And it does not weaken hang detection, which
 * is what a timeout is really for: a wedged spawn or a deadlock never returns AT ALL, so it trips 120s
 * exactly as it tripped 45s — only later. What 45s was actually catching here was honest slow work.
 *
 * The 400+ runtime/app tests are untouched and keep failing fast at 45s, which is the point of scoping
 * this by path rather than raising the global a second time (it already went 15s → 45s for this cause).
 *
 * ─── Recognising this failure, because it does not look like a slow test ───────────────────────────
 * vitest reports it at FILE level — `Test Files 1 failed` alongside `Tests 0 failed` — and WHICH tests
 * blow up MOVES between runs. Zero failed assertions plus a shifting victim list means contention, not a
 * defect. Confirm by running the file alone; if it passes, it belongs to this class.
 */
const TOOLING_TIMEOUT_MS = 120_000;

// The one path segment that selects the class. A plain literal so `grep -rn '/packages/tooling/'` finds
// this decision along with everything else scoped to that tree.
const TOOLING_PATH = '/packages/tooling/';

// `testPath` is the file currently being set up — setupFiles run once PER test file, which is what makes
// a path-scoped budget possible at all. Absent (older vitest, odd runner) ⇒ leave the global in force
// rather than guess, so a missing value can never silently widen the timeout for the whole repo.
const testPath = expect.getState().testPath ?? '';

if (testPath.includes(TOOLING_PATH)) {
    vi.setConfig({ testTimeout: TOOLING_TIMEOUT_MS, hookTimeout: TOOLING_TIMEOUT_MS });
    /**
     * Point HOME at an EMPTY throwaway directory for every `packages/tooling/**` spec.
     *
     * The tooling code reads one machine-global file — `~/.webpieces/config.json` (HomeConfigService) — and
     * it is OPTIONAL, so whether a developer happens to have one changes what these end-to-end specs
     * observe. That is a test reading the developer's personal preferences: it passes on one machine and
     * fails on the next, and CI (which has no such file) can never reproduce it. Measured, not theoretical —
     * the runner/coordinator end-to-end specs went red on a machine that had opted into an experimental
     * flag, for no reason connected to the code under test.
     *
     * An EMPTY directory is deliberately the right stand-in rather than a fixture: "no such file" is the
     * state of essentially every consumer, so it is the state a default-path test should be asserting.
     * Specs that care about a PRESENT file build their own fake home and pass it in explicitly.
     *     */
    const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-vitest-home-'));
    process.env['HOME'] = isolatedHome;
    // Windows' os.homedir() reads USERPROFILE; set both so the isolation is not platform-conditional.
    process.env['USERPROFILE'] = isolatedHome;
}
