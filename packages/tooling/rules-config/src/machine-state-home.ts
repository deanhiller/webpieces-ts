import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { WEBPIECES_TMP_DIR } from './constants';
import { toError } from './to-error';

/**
 * The environment variable that takes over completely. See {@link MachineStateHome} and
 * `decisions/0001-tree-identity-and-governance.md` § D3.
 */
export const WEBPIECES_STATE_HOME_ENV = 'WEBPIECES_STATE_HOME';

/**
 * Where the MACHINE-GLOBAL state root resolved to, and whether it is really machine-global.
 *
 * Data-only (classes for data, per CLAUDE.md). `degraded` is the whole reason this is a class rather
 * than a bare string: a caller that fell back to the clone has NOT written a machine-global artifact,
 * and any message it prints about "this machine" would be a lie. `reason` is the sentence to print.
 */
export class StateHome {
    /** The directory that IS the root. Callers append their own namespace beneath it. */
    readonly root: string;
    /** TRUE when this is the per-clone fallback, i.e. NOT visible from another clone. */
    readonly degraded: boolean;
    /** '' when not degraded; otherwise one human-readable clause naming what went wrong. */
    readonly reason: string;

    constructor(root: string, degraded = false, reason = '') {
        this.root = root;
        this.degraded = degraded;
        this.reason = reason;
    }
}

/**
 * The ONE resolver for state that belongs to the MACHINE rather than to a clone or a worktree.
 *
 * ─── Why this exists at all ────────────────────────────────────────────────────────────────────────
 * `DotWebpieces` answers "where does state for THIS TREE live" and has two scopes, shared (repo-wide)
 * and local (this worktree). Both are anchored inside the primary clone, which is correct for every
 * fact whose scope is a clone: branches, worktrees, in-flight merges.
 *
 * It is WRONG for a fact whose scope is larger than a clone. `wp-finish-upsert-pr` renders the compact
 * squash-commit body for PR #N; `wp-land-pr` must pass those exact bytes to `gh pr merge --body-file`.
 * PR #N is a fact of the REMOTE repository — the same object seen from every clone and every worktree
 * on this machine — so storing its receipt under a per-worktree namespace made landing work only while
 * the branch never changed trees. It did (the flow ran in the primary clone, landing happened from a
 * linked worktree), landing found nothing, and the artifact got copied across by hand.
 *
 * ─── D3: `WEBPIECES_STATE_HOME` is a FULL override, not a prefix ────────────────────────────────────
 * Point it at a directory and that directory IS the root — no `.webpieces` appended, no per-repo
 * nesting. That is the escape for a container/sandbox with no writable `$HOME`, and it is also "put it
 * back inside the tree" for anyone who wants that.
 *
 * ─── Never throws ──────────────────────────────────────────────────────────────────────────────────
 * D3 again: this sits under code that runs on a hook's blocking path, so an unwritable or absent `$HOME`
 * DEGRADES to `<primary clone>/.webpieces` and says so, rather than raising. A degraded home is not a
 * silent one: {@link StateHome.degraded} travels with the path, and every consumer prints the reason —
 * because a receipt written into a clone is exactly the thing that was broken to begin with, and a
 * reader who is not told will spend the next incident looking for it on the wrong machine.
 */
@injectable(bindingScopeValues.Singleton)
export class MachineStateHome {
    // Resolved roots, keyed by the fallback that was offered. Probing writability costs a mkdir + a
    // stat, and every path lookup in a command goes through here.
    private readonly cache = new Map<string, StateHome>();

    /**
     * The machine-global state root.
     *
     * @param cloneFallback the primary clone's root, used ONLY when neither the override nor `$HOME`
     *                      is usable. Pass the repo root you already resolved; it is never consulted
     *                      on the happy path.
     */
    resolve(cloneFallback: string): StateHome {
        const cached = this.cache.get(cloneFallback);
        if (cached !== undefined) return cached;
        const home = this.resolveUncached(cloneFallback);
        this.cache.set(cloneFallback, home);
        return home;
    }

    private resolveUncached(cloneFallback: string): StateHome {
        const override = (process.env[WEBPIECES_STATE_HOME_ENV] ?? '').trim();
        if (override !== '') {
            // FULL override: this directory IS the root. No `<key>` nesting, no `.webpieces` suffix.
            if (this.usable(override)) return new StateHome(path.resolve(override));
            return new StateHome(
                path.join(cloneFallback, WEBPIECES_TMP_DIR), true,
                `${WEBPIECES_STATE_HOME_ENV}=${override} is not a writable directory`);
        }

        const home = this.homeDir();
        if (home !== '') {
            const root = path.join(home, WEBPIECES_TMP_DIR);
            if (this.usable(root)) return new StateHome(root);
            return new StateHome(
                path.join(cloneFallback, WEBPIECES_TMP_DIR), true,
                `${root} could not be created or written to`);
        }

        return new StateHome(
            path.join(cloneFallback, WEBPIECES_TMP_DIR), true,
            'this process has no home directory ($HOME is unset and os.homedir() gave nothing)');
    }

    /**
     * `$HOME` FIRST, `os.homedir()` second — deliberately not the other way round.
     *
     * On macOS `os.homedir()` falls back to the PASSWORD DATABASE when `$HOME` is unset, so it happily
     * returns the real home of a process that was launched with a scrubbed environment on purpose. It
     * also makes `HOME=<tmp>` untestable, and a state root nothing can point at a temp directory is a
     * state root nothing has real tests for.
     */
    private homeDir(): string {
        const fromEnv = (process.env['HOME'] ?? '').trim();
        if (fromEnv !== '') return fromEnv;
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: os.homedir() throws on some sandboxes; '' is the honest answer
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return (os.homedir() ?? '').trim();
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return '';
        }
    }

    // Can we actually create and write inside `dir`? Probed by creating it and writing a marker rather
    // than by reading mode bits: a read-only mount, an SELinux/sandbox denial and a plain permission
    // error all present differently in `stat`, and all of them fail the write identically.
    private usable(dir: string): boolean {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: any filesystem refusal means "not usable", never a crash
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            fs.mkdirSync(dir, { recursive: true });
            const probe = path.join(dir, '.writable-probe');
            fs.writeFileSync(probe, '');
            fs.rmSync(probe, { force: true });
            return true;
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return false;
        }
    }
}

/**
 * Process-wide instance for the many non-DI call sites, mirroring `dotWebpieces`. Inversify still
 * injects the singleton wherever a container is in play.
 */
export const machineStateHome = new MachineStateHome();
