import * as fs from 'fs';
import * as path from 'path';
import {
    BriefedFile, ContextEntry, PrGateConfig, RequiredChecklist, ReviewerBriefing, ReviewJsonService, toError,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { DiffManifest, DiffManifestEntry } from './diff-materializer';
import { ChecklistScan } from './checklist-scanner';

/**
 * Turns a {@link ChecklistScan} plus the materialized {@link DiffManifest} into one {@link ReviewerBriefing}
 * per reviewer — resolving every path to an absolute one, because a reviewer that has to resolve a path
 * ends up searching, and searching is the cost this whole feature exists to remove.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is injected by type and drawn in the DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class ReviewerBriefingBuilder {
    constructor(private readonly reviewJsonService: ReviewJsonService) {}

    build(repoRoot: string, scan: ChecklistScan, manifest: DiffManifest, diffDir: string, config: PrGateConfig): ReviewerBriefing[] {
        // Resolved ONCE for the whole run, not per reviewer: `require.resolve` hits the filesystem, and the
        // answer cannot differ between two reviewers in the same process.
        const shared = this.contextEntries(repoRoot, config);
        const entryByFile = new Map<string, DiffManifestEntry>();
        for (const e of manifest.entries) entryByFile.set(e.file, e);
        return scan.applicable.map((req: RequiredChecklist): ReviewerBriefing =>
            this.one(repoRoot, req, scan, entryByFile, diffDir, shared, manifest));
    }

    // eslint-disable-next-line @typescript-eslint/max-params
    private one(
        repoRoot: string, req: RequiredChecklist, scan: ChecklistScan,
        entryByFile: Map<string, DiffManifestEntry>, diffDir: string, shared: ContextEntry[], manifest: DiffManifest,
    ): ReviewerBriefing {
        const b = new ReviewerBriefing(req.subagent, req.id, repoRoot);
        b.docPath = req.doc.trim() === '' ? '' : path.resolve(repoRoot, req.doc);
        b.diffDir = diffDir;
        b.allDiffPath = diffDir === '' ? '' : path.join(diffDir, 'ALL.diff');
        b.manifestPath = diffDir === '' ? '' : path.join(diffDir, 'manifest.json');
        b.myFiles = req.matchedFiles.map((f: string): BriefedFile => this.briefedFile(repoRoot, f, entryByFile));
        b.matchedPatterns = req.matchedPatterns;
        b.required = req.required;
        b.sourceDirs = this.sourceDirsFor(repoRoot, req.matchedFiles);
        b.contextEntries = shared;
        b.verdictPath = this.reviewJsonService.checklistResultPath(scan.reviewPath, req.id);
        b.fileDiffCommand = scan.context.fileDiffCommand;
        b.dirty = scan.basis.dirty;
        b.ownAgentFileInDiff = this.ownAgentFileIn(manifest, req.subagent);
        this.copyManifestFacts(b, manifest);
        return b;
    }

    /**
     * One row of the reviewer's table. The SOURCE path comes over with the diff path because the two need
     * identical affordance: when the diff was an absolute path and the source was a parent directory, four of
     * four reviewers read the diff and none opened a source file.
     */
    private briefedFile(repoRoot: string, file: string, entryByFile: Map<string, DiffManifestEntry>): BriefedFile {
        const e = entryByFile.get(file);
        if (e === undefined) return new BriefedFile(file, '', path.resolve(repoRoot, file));
        return new BriefedFile(file, e.diffAbs, e.fileAbs, e.status, e.bytes, e.truncated);
    }

    /**
     * Manifest headline facts, copied onto the briefing so the instructions can state them INLINE. A reviewer
     * that never opens the manifest still has to learn whether anything was truncated or excluded — that is
     * precisely the thing it could not otherwise know it was missing.
     */
    private copyManifestFacts(b: ReviewerBriefing, manifest: DiffManifest): void {
        b.changedFileCount = manifest.entries.length;
        b.truncatedCount = manifest.entries.filter((e: DiffManifestEntry): boolean => e.truncated).length;
        b.excludedCount = manifest.excluded.length;
        b.allDiffLines = manifest.allDiffLines;
        b.allDiffBytes = manifest.allDiffBytes;
        b.hashForkPoint = manifest.hashForkPoint;
        b.hashFeatureHead = manifest.hashFeatureHead;
        b.hashMainHead = manifest.hashMainHead;
    }

    /**
     * The reviewer's own `.claude/agents/<subagent>.md`, when THIS diff changes it. Detected here rather than
     * left to the reviewer to notice: on the measured run two reviewers reviewed their own definition and
     * neither mentioned it, and every PR that edits the review gate reproduces that.
     */
    private ownAgentFileIn(manifest: DiffManifest, subagent: string): string {
        const suffix = path.join('.claude', 'agents', `${subagent}.md`);
        const hit = manifest.entries.find((e: DiffManifestEntry): boolean => e.file.split('/').join(path.sep).endsWith(suffix));
        return hit === undefined ? '' : (hit.fileAbs === '' ? hit.file : hit.fileAbs);
    }

    /**
     * Deduped absolute parent dirs of the matched files. Dirs rather than files because the point is to say
     * "the neighbourhood is here" — a reviewer already has the file list; what it lacks is where to look for
     * the code AROUND the change.
     */
    private sourceDirsFor(repoRoot: string, files: readonly string[]): string[] {
        const dirs = new Set<string>();
        for (const f of files) dirs.add(path.resolve(repoRoot, path.dirname(f)));
        return [...dirs].sort();
    }

    /**
     * The pre-resolved context list, from two config keys with deliberately different jobs:
     *
     * `reviewContextPackages` — installed packages, resolved to their real on-disk dir. This is what deletes
     *   the repeated `node_modules/@webpieces` greps: the tooling knows where a package resolved to, and the
     *   reviewer does not.
     * `reviewContext` — the repo-specific escape hatch (`{label, path}`) for what tooling cannot possibly
     *   guess, e.g. "queue names live in terraform/services/".
     *
     * Neither ever drops an entry: an unresolvable package or a missing path is LISTED, with the reason. A
     * silently shorter list is indistinguishable from a complete one.
     */
    private contextEntries(repoRoot: string, config: PrGateConfig): ContextEntry[] {
        const entries: ContextEntry[] = [];
        for (const pkg of config.reviewContextPackages) entries.push(this.resolvePackage(repoRoot, pkg));
        for (const item of config.reviewContext) {
            const abs = path.resolve(repoRoot, item.path);
            entries.push(fs.existsSync(abs)
                ? new ContextEntry(item.label, abs)
                : new ContextEntry(item.label, '', `(configured as "${item.path}" but missing)`));
        }
        return entries;
    }

    private resolvePackage(repoRoot: string, pkg: string): ContextEntry {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: an unresolvable package is REPORTED as such, never fatal
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const manifestPath = require.resolve(`${pkg}/package.json`, { paths: [repoRoot] });
            const dir = path.dirname(manifestPath);
            // webpieces-disable no-any-unknown -- opaque package.json, only `description` is read
            const meta = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
            const desc = typeof meta['description'] === 'string' ? (meta['description'] as string) : '';
            return new ContextEntry(desc === '' ? pkg : `${pkg} — ${desc}`, dir);
        } catch (err: unknown) {
            const error = toError(err);
            void error; // an unresolvable package is REPORTED below, never fatal
            return new ContextEntry(pkg, '', '(not installed — configured in pr-gate.reviewContextPackages)');
        }
    }
}
