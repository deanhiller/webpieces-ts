import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';
import { DotWebpieces, dotWebpieces } from './state-dir';

// ---------------------------------------------------------------------------
// SHORT-LIVED RUNTIME SCRATCH FILES BELONG IN `.webpieces/`, NOT IN `$TMPDIR`.
//
// Two `wp-*` code paths needed a path on disk for the length of one subprocess call — the squash body for
// `gh pr merge --body-file`, and the nx graph dump — and both reached for `os.tmpdir()`. Neither has the
// reason that justifies `$TMPDIR` for a SPEC fixture (see `spec-temp-dirs.ts`): they are not isolating
// themselves from the developer's `$HOME`, and they do not `git init` inside themselves. They are
// ordinary gate state, and every other piece of gate state lives under `.webpieces/`.
//
// Putting them there is not tidiness — it is what gives them an OWNER. `CleanTmp` already sweeps
// `DotWebpieces.local()` on a 30-day retention at the end of every merge/PR flow, so a scratch file
// written here is reaped by a mechanism that already exists and is already tested. The same file in
// `$TMPDIR` had no owner at all, which is how 4,222 `wp-merge-body-` directories accumulated on one
// machine.
// ---------------------------------------------------------------------------

/** The subdirectory of the per-worktree `.webpieces` scope that holds throwaway runtime files. */
export const SCRATCH_DIR_NAME = 'scratch';

/**
 * Creates short-lived scratch directories under this worktree's `.webpieces/` scope.
 *
 * `local()` (not `aiWritable()`) is the right scope: these files are written by the TOOLING, never by an
 * agent, and `local()` keeps them under the primary clone so they outlive a reaped worktree exactly like
 * the gate logs beside them.
 */
@injectable(bindingScopeValues.Singleton)
export class RepoScratchDirs {
    constructor(private readonly dotDir: DotWebpieces = dotWebpieces) {}

    /**
     * `fs.mkdtempSync` under `<.webpieces scope>/scratch/`, creating the parent if this is the first call.
     *
     * `prefix` keeps the `wp-<area>-` convention, so a leftover names the code path that wrote it.
     */
    make(repoRoot: string, prefix: string): string {
        const base = path.join(this.dotDir.local(repoRoot), SCRATCH_DIR_NAME);
        fs.mkdirSync(base, { recursive: true });
        return fs.mkdtempSync(path.join(base, prefix));
    }
}
