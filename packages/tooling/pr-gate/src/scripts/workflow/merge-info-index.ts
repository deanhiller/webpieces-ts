import * as fs from 'fs';
import * as path from 'path';
import { toError } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

import { ARCHIVE_RECORD_FILE, MERGED_DIR, MERGE_INDEX_FILE, MergeState } from './merge-state';

/**
 * `.webpieces/merge-info/index.json` — the one answer to "which merges, across ALL branches, were
 * 3-point?", which is the actual review question.
 *
 * WHY AN INDEX IS REQUIRED and a directory name will not do: a single branch can alternate
 * clean → 3-point → clean → 3-point across its syncs. So the clean/3-point axis belongs to the MERGE,
 * not the branch, and cannot be encoded in `merged/<branch>/`. With the index, one jq lists every
 * 3-point merge in the repo and stays correct for alternating branches:
 *
 *   jq -r '.merged | to_entries[] | .key as $b | .value.merges[] |
 *          select(.threeWay) | "\($b) merge-\(.n)"' .webpieces/merge-info/index.json
 *
 * WHY IT IS DERIVED, NOT INCREMENTALLY WRITTEN: every fact in it already exists on disk — `threeWay`
 * is the presence of `conflicts.md` in the run dir, `conflicts` is that file's list, and the archive
 * fields come from `archive.json`. Rebuilding by scanning `merged/` makes the index a pure projection
 * that cannot drift from the directories, and makes a lost or corrupt index self-healing.
 */

// One merge slot within a branch. Data-only (per CLAUDE.md, classes for data).
export class MergeRecord {
    n: number;
    threeWay: boolean;
    // Only non-empty when threeWay — the files the AI actually had to resolve.
    conflicts: string[];

    constructor(n: number, threeWay: boolean, conflicts: string[]) {
        this.n = n;
        this.threeWay = threeWay;
        this.conflicts = conflicts;
    }
}

// `{ archiveTag, tipSha, baseSha, pr, mergedAt }` — the landed branch's archive record, written into
// `merged/<feature>/archive.json` and mirrored into the index so one file answers everything.
export class ArchiveRecord {
    archiveTag: string;
    tipSha: string;
    baseSha: string;
    pr: number;
    mergedAt: string;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(archiveTag: string, tipSha: string, baseSha: string, pr: number, mergedAt: string) {
        this.archiveTag = archiveTag;
        this.tipSha = tipSha;
        this.baseSha = baseSha;
        this.pr = pr;
        this.mergedAt = mergedAt;
    }
}

// One landed branch's whole story: which PR, where its history is archived, and every merge it took.
export class MergedBranchEntry {
    pr: number;
    archiveTag: string;
    merges: MergeRecord[];

    constructor(pr: number, archiveTag: string, merges: MergeRecord[]) {
        this.pr = pr;
        this.archiveTag = archiveTag;
        this.merges = merges;
    }
}

// The whole file. `merged` is keyed by feature slug, matching the `merged/<feature>/` dir names.
export class MergeInfoIndexFile {
    merged: Record<string, MergedBranchEntry>;

    constructor(merged: Record<string, MergedBranchEntry>) {
        this.merged = merged;
    }
}

// Raw JSON shape for the cast at the parse boundary.
interface RawArchiveRecord {
    archiveTag?: string;
    tipSha?: string;
    baseSha?: string;
    pr?: number;
    mergedAt?: string;
}

@injectable(bindingScopeValues.Singleton)
export class MergeInfoIndex {
    constructor(private readonly mergeState: MergeState) {}

    indexPath(repoRoot: string): string {
        return path.join(this.mergeState.mergeInfoRoot(repoRoot), MERGE_INDEX_FILE);
    }

    /**
     * MOVE a landed feature's whole `staged/<feature>/` tree to `merged/<feature>/`, drop its
     * `archive.json` in, and rebuild the index. This is what makes `staged/` self-cleaning: it holds
     * only branches still in flight, instead of growing for the life of the repo.
     *
     * Returns false when there was nothing staged to promote (a branch that landed without ever syncing
     * from main), which is a normal outcome and not an error.
     */
    promoteToMerged(repoRoot: string, featureName: string, archive: ArchiveRecord): boolean {
        const staged = this.mergeState.stagedDirFor(repoRoot, featureName);
        const merged = this.mergeState.mergedDirFor(repoRoot, featureName);
        if (!fs.existsSync(staged)) {
            this.rebuildIndex(repoRoot);
            return false;
        }
        fs.mkdirSync(path.dirname(merged), { recursive: true });
        // An existing merged/<feature> means the same branch name landed before. Keep BOTH — the older
        // record moves aside rather than being overwritten, since it is the audit trail of a real PR.
        if (fs.existsSync(merged)) fs.renameSync(merged, `${merged}-prev-${String(Date.now())}`);
        fs.renameSync(staged, merged);
        fs.writeFileSync(path.join(merged, ARCHIVE_RECORD_FILE), JSON.stringify(archive, null, 2) + '\n');
        this.rebuildIndex(repoRoot);
        return true;
    }

    /** Rebuild `index.json` by scanning `merged/` from scratch. Pure projection of what is on disk. */
    rebuildIndex(repoRoot: string): MergeInfoIndexFile {
        const mergedRoot = path.join(this.mergeState.mergeInfoRoot(repoRoot), MERGED_DIR);
        const entries: Record<string, MergedBranchEntry> = {};
        if (fs.existsSync(mergedRoot)) {
            for (const feature of fs.readdirSync(mergedRoot)) {
                const home = path.join(mergedRoot, feature);
                if (!fs.statSync(home).isDirectory()) continue;
                entries[feature] = this.entryFor(home);
            }
        }
        const index = new MergeInfoIndexFile(entries);
        const target = this.indexPath(repoRoot);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(index, null, 2) + '\n');
        return index;
    }

    // One landed branch, derived entirely from its own directory: the archive record it was promoted
    // with, plus one MergeRecord per `merge-<n>/` whose threeWay is the presence of conflicts.md.
    private entryFor(home: string): MergedBranchEntry {
        const archive = this.readArchive(home);
        const merges: MergeRecord[] = [];
        for (const n of this.mergeState.listMergeRunDirs(home)) {
            const runDir = path.join(home, `merge-${String(n)}`);
            const threeWay = this.mergeState.wasThreeWay(runDir);
            merges.push(new MergeRecord(n, threeWay, threeWay ? this.mergeState.readConflictedFiles(runDir) : []));
        }
        return new MergedBranchEntry(archive.pr, archive.archiveTag, merges);
    }

    // Missing/corrupt archive.json degrades to empty fields rather than failing the whole index — the
    // merge records are still worth publishing, and a lost archive tag is not worth losing them over.
    private readArchive(home: string): ArchiveRecord {
        const filePath = path.join(home, ARCHIVE_RECORD_FILE);
        if (!fs.existsSync(filePath)) return new ArchiveRecord('', '', '', 0, '');
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as RawArchiveRecord;
            return new ArchiveRecord(
                raw.archiveTag ?? '', raw.tipSha ?? '', raw.baseSha ?? '', raw.pr ?? 0, raw.mergedAt ?? '');
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return new ArchiveRecord('', '', '', 0, '');
        }
    }
}
