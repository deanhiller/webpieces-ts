import { spawnSync } from 'child_process';
import * as path from 'path';

import { findConfigFile } from './config-file';
import { WEBPIECES_TMP_DIR } from './constants';

// The single instruct-ai home under `.webpieces/`. Kept here (not just in load-template) so callers
// building AI-facing messages can render the ABSOLUTE doc path from a resolved repo root.
export const INSTRUCT_AI_DIR = `${WEBPIECES_TMP_DIR}/instruct-ai`;

/**
 * Resolves the single repo root that owns the `.webpieces/` tree, and renders absolute paths beneath
 * it.
 *
 * `.webpieces/` MUST live at the repo root — never in a CWD-dependent subdirectory. A tool invoked
 * from a subdir (a nested package, a `services/*` app) that naively joined `.webpieces` onto its own
 * cwd would scatter stray `.webpieces` trees across the tree — the exact bug this prevents. Every
 * writer of `.webpieces/...` (logs, instruct-ai docs, sync cache, merge/pr state) MUST anchor its
 * path here rather than at `process.cwd()`.
 */
export class RepoRootFinder {
    /**
     * The repo root for `startDir`. Resolution order (first hit wins):
     *   1. Directory holding webpieces.config.json — the webpieces workspace root, and the exact
     *      anchor the hook runner already uses. Walks UP from startDir, so a subdir resolves to root.
     *   2. git toplevel (`git rev-parse --show-toplevel`) — the repo root when no config is present
     *      yet (e.g. the installer runs before webpieces.config.json exists).
     *   3. `startDir` — last resort (git unavailable / not a repo / no config). Best-effort only.
     */
    resolveRepoRoot(startDir: string): string {
        const configPath = findConfigFile(startDir);
        if (configPath !== null) return path.dirname(configPath);
        const gitRoot = this.gitToplevel(startDir);
        if (gitRoot !== null) return gitRoot;
        return startDir;
    }

    /**
     * Absolute path to an instruct-ai doc under `repoRoot`. Hand THIS to the AI in a violation/fix
     * message — never a bare `.webpieces/instruct-ai/...` relative path, which an AI whose cwd is a
     * subdirectory would resolve against the wrong directory and fail to open.
     */
    instructAiDocPath(repoRoot: string, docName: string): string {
        return path.join(repoRoot, INSTRUCT_AI_DIR, docName);
    }

    /** Absolute instruct-ai doc path resolved directly from `startDir` (resolveRepoRoot + join). */
    docPathFrom(startDir: string, docName: string): string {
        return this.instructAiDocPath(this.resolveRepoRoot(startDir), docName);
    }

    // git repo root of `cwd`, or null when cwd is not in a git repo. `status !== 0` is the EXPECTED
    // "not a repo" value (spawnSync does not throw on non-zero exit), so we never swallow a real
    // failure with try/catch — a genuine git crash still surfaces. Mirrors runner.ts:gitToplevel.
    private gitToplevel(cwd: string): string | null {
        const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
        if (r.status !== 0) return null;
        const root = (r.stdout ?? '').trim();
        return root !== '' ? root : null;
    }
}
