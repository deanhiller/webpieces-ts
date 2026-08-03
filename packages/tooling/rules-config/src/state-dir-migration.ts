import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { toError } from './to-error';

/**
 * What a migration did. Data-only (per CLAUDE.md: classes for data, explicit construction).
 *
 * `kept` is the important half: an entry that could NOT be moved because the destination already holds
 * something at that path. Nothing in `kept` is ever deleted — it stays where it is, for a human.
 */
export class StateMigrationReport {
    moved: string[] = [];
    kept: string[] = [];

    get movedAnything(): boolean {
        return this.moved.length > 0;
    }
}

/**
 * Moves a LEGACY per-worktree `.webpieces/` REAL DIRECTORY into the worktree's namespace inside the
 * primary clone (`<primary>/.webpieces/worktrees/<name>/`).
 *
 * NO SYMLINK IS EVER CREATED in its place — an earlier draft of this design planned one and this
 * comment still said so, which is worse than silence: it told the reader to expect an indirection
 * that does not exist. `DotWebpieces` resolves the namespace path EXPLICITLY (see its "Why two
 * explicit methods and not a symlink" section, which records why the link was rejected: lazy creation
 * with three failure modes, a Windows hazard, and `rename(2)` silently REPLACING the link). After a
 * migration the legacy `<worktree>/.webpieces/` is simply gone; nothing takes its place.
 *
 * WHY it must exist: those directories hold REAL in-flight state — a half-finished 3-point merge under
 * `merge-info/staged/<branch>/`, a written-but-not-yet-posted `pr-review/<branch>/review.json`. The
 * first invocation under the new scheme must not orphan them; a merge an agent is standing in the
 * middle of is not recoverable by re-running anything.
 *
 * WHY a plain move suffices: the destination namespace is created FOR this worktree, so it is empty in
 * the ordinary case and the whole tree moves in one `rename`. Where something is already there (a
 * repeat run, or an old PUBLISHED build having written to the legacy path again mid-transition), we
 * descend and move only what is free.
 *
 * SAFETY RULE, absolute: this never deletes or overwrites anything that holds content. If a
 * destination path is occupied, the legacy copy is LEFT WHERE IT IS and reported loudly on stderr.
 * Empty directories are removed as they drain, which is how a fully-migrated legacy `.webpieces/`
 * disappears on its own and lets the symlink be created.
 *
 * It is also the answer to the PUBLISHED-vs-LOCAL transition window. The `wp-*` bins and the hooks run
 * the PUBLISHED package, so for a while some invocations still create a REAL `<worktree>/.webpieces`
 * directory. Because this runs on the first state-dir resolution of EVERY new-code process, anything an
 * old-code invocation deposited is swept into the worktree namespace before any reader looks — and a
 * reader running old code finds it through the symlink either way. The two schemes converge instead of
 * splitting; nothing is lost in either direction.
 */
@injectable(bindingScopeValues.Singleton)
export class StateDirMigrator {
    /**
     * Drain `legacyDir` into `targetDir`. A no-op when they are the same directory or when the legacy
     * dir does not exist / is not a real directory (a symlink means migration already happened).
     */
    migrate(legacyDir: string, targetDir: string): StateMigrationReport {
        const report = new StateMigrationReport();
        if (path.resolve(legacyDir) === path.resolve(targetDir)) return report;

        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            if (!this.isRealDirectory(legacyDir)) return report;
            fs.mkdirSync(targetDir, { recursive: true });
            this.drain(legacyDir, targetDir, '', report);
            this.removeIfEmpty(legacyDir);
        } catch (err: unknown) {
            const error = toError(err);
            this.warn(`could not migrate ${legacyDir} into ${targetDir}: ${error.message}`);
            return report;
        }

        this.announce(legacyDir, targetDir, report);
        return report;
    }

    /**
     * Relocate every `*.log` FILE sitting directly in `hooksDir` into `logsDir` — the hooks/ → logs/
     * split (see LOGS_STATE_DIR). Same shape and the same safety rule as {@link migrate}: `rename`
     * first, an occupied destination is LEFT ALONE and reported, nothing is ever deleted or
     * overwritten. Deliberately NON-recursive and extension-scoped, because the rest of `hooks/` is
     * not log data — the dated `hooks/<YYYY-MM-DD>/writeInfo-*.md` rejection details stay exactly
     * where they are, and a recursive sweep would drag them along.
     *
     * `hooksDir` normally still exists after this (it holds those dated dirs); it is removed only if
     * draining the logs left it genuinely empty.
     */
    migrateLogFiles(hooksDir: string, logsDir: string): StateMigrationReport {
        const report = new StateMigrationReport();
        if (path.resolve(hooksDir) === path.resolve(logsDir)) return report;

        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            if (!this.isRealDirectory(hooksDir)) return report;
            const logs = fs.readdirSync(hooksDir, { withFileTypes: true })
                .filter((entry: fs.Dirent): boolean => entry.isFile() && entry.name.endsWith('.log'));
            if (logs.length === 0) return report;

            fs.mkdirSync(logsDir, { recursive: true });
            for (const entry of logs) {
                const destination = path.join(logsDir, entry.name);
                if (fs.existsSync(destination)) {
                    report.kept.push(entry.name);
                    continue;
                }
                this.relocate(path.join(hooksDir, entry.name), destination, entry.name, report);
            }
            this.removeIfEmpty(hooksDir);
        } catch (err: unknown) {
            const error = toError(err);
            this.warn(`could not move logs from ${hooksDir} into ${logsDir}: ${error.message}`);
            return report;
        }

        this.announce(hooksDir, logsDir, report);
        return report;
    }

    /**
     * Move everything under `<legacyRoot>/<relative>` to `<targetRoot>/<relative>`.
     *
     * A whole subtree whose destination is free moves in ONE `rename` — which is what keeps an
     * in-flight `merge-info/staged/<branch>/` intact rather than copying it file by file and risking a
     * half-moved merge. Only when the destination is an existing DIRECTORY do we descend and consider
     * its children individually.
     */
    private drain(legacyRoot: string, targetRoot: string, relative: string, report: StateMigrationReport): void {
        const from = path.join(legacyRoot, relative);
        for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
            const childRelative = path.join(relative, entry.name);
            const source = path.join(legacyRoot, childRelative);
            const destination = path.join(targetRoot, childRelative);

            if (!fs.existsSync(destination)) {
                this.relocate(source, destination, childRelative, report);
                continue;
            }
            if (entry.isDirectory() && fs.statSync(destination).isDirectory()) {
                this.drain(legacyRoot, targetRoot, childRelative, report);
                this.removeIfEmpty(source);
                continue;
            }
            report.kept.push(childRelative);
        }
    }

    // Move one file or subtree to a free destination. `rename` first (atomic, instant, and the only
    // form that cannot half-move a merge); a cross-device rename falls back to copy-then-remove.
    private relocate(source: string, destination: string, relative: string, report: StateMigrationReport): void {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            fs.renameSync(source, destination);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            fs.cpSync(source, destination, { recursive: true });
            fs.rmSync(source, { recursive: true, force: true });
        }
        report.moved.push(relative);
    }

    // A real directory, not a symlink to one — `lstat` on purpose. A symlink here is the NEW scheme
    // already in place, and following it would make the migrator try to drain a directory into itself.
    private isRealDirectory(dir: string): boolean {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return fs.lstatSync(dir).isDirectory();
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return false;
        }
    }

    // Remove a directory only when it is genuinely empty. Never recursive — a non-empty legacy dir is
    // state a human still needs.
    private removeIfEmpty(dir: string): void {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            if (!fs.existsSync(dir)) return;
            if (fs.readdirSync(dir).length > 0) return;
            fs.rmdirSync(dir);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
        }
    }

    // Migration is invisible by design when it goes cleanly; anything LEFT BEHIND must be shouted about,
    // because that is the only case where a human has to do something.
    private announce(legacyDir: string, targetDir: string, report: StateMigrationReport): void {
        if (report.kept.length === 0) return;
        this.warn(
            `${String(report.kept.length)} item(s) in ${legacyDir} could NOT move into ${targetDir} because ` +
            `that path is already occupied. NOTHING was deleted — resolve by hand if any of these still ` +
            `matters (an in-flight merge, or log history you have not read): ${report.kept.join(', ')}`,
        );
    }

    private warn(message: string): void {
        process.stderr.write(`[webpieces] .webpieces state migration: ${message}\n`);
    }
}
