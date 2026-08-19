import { injectable, bindingScopeValues } from 'inversify';

import { OrphanCandidate, OrphanDirScanner } from './orphan-dir-scan';
import { ArchivedOrphan, FailedOrphan, OrphanDirArchiver, OrphanSweepResult } from './orphan-dir-archive';
import { HOME_EXPERIMENTAL_SECTION, HOME_KEY_ORPHAN_DIR_SWEEP, HomeConfigService } from './home-config';

/**
 * The orphan-directory sweep, end to end: find the corpses an `nx g move` left behind, and — only on a
 * machine that has explicitly opted in — archive them where they can be recovered.
 *
 * ─── WHY THE DEFAULT IS REPORT-ONLY, AND WHY THE FLAG IS REQUIRED ─────────────────────────────────────
 * `experimental.orphan-dir-sweep` in `~/.webpieces/config.json` is a REQUIRED boolean once that file
 * exists, and its absent-file value is false. That gives the author of this feature exactly one thing
 * nothing else can: they can run it live across all of their own clones for a release, while every
 * colleague pulling the same version gets a report and an untouched working tree.
 *
 * Required rather than defaulted for the reason home-config.ts already states about
 * `whole-repo-build-guard`: a flag that only changes what a message SAYS may default; a flag that decides
 * whether a command RUNS may not. This one decides whether directories MOVE, which is a step further
 * again — nobody may discover this feature by finding their directories somewhere else.
 *
 * ─── WHY IT NEVER THROWS ──────────────────────────────────────────────────────────────────────────────
 * Every caller is a command whose real work is a checkout and a pull. Tidying is worth doing on the back
 * of that, and worth nothing at all if it can fail the thing it rode in on, so every failure below
 * resolves to a line of prose in the report. The one exception is deliberate: a MALFORMED
 * `~/.webpieces/config.json` propagates, because that file is the user's own instruction to this code and
 * silently ignoring a broken one is how a machine ends up in a state its owner did not choose.
 */
@injectable(bindingScopeValues.Singleton)
export class OrphanDirSweeper {
    constructor(
        private readonly scanner: OrphanDirScanner,
        private readonly archiver: OrphanDirArchiver,
        private readonly homeConfigService: HomeConfigService,
    ) {}

    /**
     * Scan `repoRoot`, and archive what was found when this machine has opted in. `now` is a parameter
     * so specs pin the sweep id rather than racing the clock.
     */
    sweep(repoRoot: string, now: Date): OrphanSweepReport {
        const candidates = this.scanner.scan(repoRoot);
        const enabled = this.homeConfigService.load().orphanDirSweep;
        if (candidates.length === 0) return new OrphanSweepReport(enabled, candidates, null, 0);
        if (!enabled) return new OrphanSweepReport(false, candidates, null, 0);
        const result = this.archiver.archive(repoRoot, candidates, now);
        return new OrphanSweepReport(true, candidates, result, this.archiver.reapAged(repoRoot, now));
    }
}

/**
 * What one sweep found and did, and how to say it out loud. Data-only apart from `render()`, which is
 * the report's own presentation of itself rather than business logic living somewhere else.
 */
export class OrphanSweepReport {
    /** Was archiving switched on for this machine? False means nothing on disk was touched. */
    enabled: boolean;
    /** Every orphan directory found, whether or not it was archived. */
    found: readonly OrphanCandidate[];
    /** The archive, or null when this was a report-only run or there was nothing to archive. */
    result: OrphanSweepResult | null;
    /** How many aged sweep directories were reaped from the trash on this run. */
    reapedSweeps: number;

    constructor(enabled: boolean, found: readonly OrphanCandidate[], result: OrphanSweepResult | null,
        reapedSweeps: number) {
        this.enabled = enabled;
        this.found = found;
        this.result = result;
        this.reapedSweeps = reapedSweeps;
    }

    /**
     * The human-facing block, or empty string when there is nothing to say. A clean tree prints NOTHING —
     * this rides along on somebody else's command, and a tidier that announces having found no work is a
     * tidier people start ignoring, and then stop reading the run where it did find some.
     */
    render(): string {
        if (this.found.length === 0) return '';
        if (!this.enabled) return this.renderReportOnly();
        return this.renderArchived();
    }

    /**
     * The opted-out form: name what was found, name the one edit that turns archiving on, and touch
     * nothing. It names the KEY rather than describing it, because the reader is usually an agent and the
     * mechanical edit is the only part of this it can act on.
     */
    private renderReportOnly(): string {
        return `${this.heading()}\n`
            + `  Nothing was moved — archiving is off on this machine.\n`
            + `  To archive them (never delete: they move to .webpieces/trash/<sweepId>/ with a recover=\n`
            + `  command printed for each), set this in ~/.webpieces/config.json:\n\n`
            + `      { "${HOME_EXPERIMENTAL_SECTION}": { "${HOME_KEY_ORPHAN_DIR_SWEEP}": true } }\n`;
    }

    private renderArchived(): string {
        const lines: string[] = [this.heading()];
        const result = this.result;
        if (result === null) return `${lines.join('\n')}\n`;
        lines.push(`  archived to ${result.sweepDir}`);
        for (const moved of result.moved) {
            lines.push(`    ${moved.relativePath}`);
            lines.push(`      recover=${moved.recoverCommand}`);
        }
        for (const failure of result.failed) {
            lines.push(`    SKIPPED ${failure.relativePath} — ${failure.reason}`);
        }
        if (this.reapedSweeps > 0) {
            lines.push(`  reaped ${this.reapedSweeps} sweep(s) older than 30 days from the trash`);
        }
        return `${lines.join('\n')}\n`;
    }

    private heading(): string {
        const count = this.found.length;
        return `orphan directories (left by a project move; every file under them is git-ignored): ${count}`;
    }

    /** Everything archived on this run — empty on a report-only run. Convenience for callers and specs. */
    archived(): readonly ArchivedOrphan[] {
        return this.result === null ? [] : this.result.moved;
    }

    /** Everything found but not movable — empty on a report-only run. */
    skipped(): readonly FailedOrphan[] {
        return this.result === null ? [] : this.result.failed;
    }
}
