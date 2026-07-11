import * as fs from 'fs';
import * as path from 'path';
import {
    WEBPIECES_TMP_DIR,
    MERGE_INFO_DIR,
    MERGE_IN_PROGRESS_FILE,
    MERGE_EXPLANATION_FILE,
} from '@webpieces/rules-config';
import { provideSingleton } from '@webpieces/core-context';
import { injectable } from 'inversify';

// Proof-obligation marker written when a 3-point squash-merge hits conflicts. Its mere
// presence (with validated=false) is what the merge-in-progress-guard hook uses to block
// commit/push/PR until `wp-finish-upsert-pr` validates the resolution and flips it true.
export class MergeMarker {
    currentBranch: string;
    squashBranch: string;
    backupBranch: string;
    prNumber: string;
    conflictedFiles: string[];
    forkPoint: string;
    featureHead: string;
    mainHead: string;
    validated: boolean;

    constructor(
        currentBranch: string,
        squashBranch: string,
        backupBranch: string,
        prNumber: string,
        conflictedFiles: string[],
        forkPoint: string,
        featureHead: string,
        mainHead: string,
        validated: boolean,
    ) {
        this.currentBranch = currentBranch;
        this.squashBranch = squashBranch;
        this.backupBranch = backupBranch;
        this.prNumber = prNumber;
        this.conflictedFiles = conflictedFiles;
        this.forkPoint = forkPoint;
        this.featureHead = featureHead;
        this.mainHead = mainHead;
        this.validated = validated;
    }
}

export class MarkerScanResult {
    clean: boolean;
    filesWithMarkers: string[];

    constructor(clean: boolean, filesWithMarkers: string[]) {
        this.clean = clean;
        this.filesWithMarkers = filesWithMarkers;
    }
}

// Data-only: the three commit points of a 3-point merge as persisted in `updatemain-hashes.json`
// (the exact key shape the conflict path already writes), plus when it was recorded.
export class MergeHashRecord {
    hashForkPoint: string;
    hashFeatureHead: string;
    hashMainHead: string;
    timestamp: string;

    constructor(hashForkPoint: string, hashFeatureHead: string, hashMainHead: string, timestamp: string) {
        this.hashForkPoint = hashForkPoint;
        this.hashFeatureHead = hashFeatureHead;
        this.hashMainHead = hashMainHead;
        this.timestamp = timestamp;
    }
}

const CONFLICT_MARKER_RE = /^(<{7}|={7}|>{7})/m;

// Marker written for a CLEAN (no-conflict) sync so every merge — not just conflicted ones — leaves a
// durable, self-describing record under `merge-info/<feature>/merge-<n>/`. A clean merge produces no
// per-file `merge-explanation.md`; this file is the "yes, a merge happened here, and it needed no
// 3-point resolution" proof, with the A/B/C shas kept so it stays auditable.
export const NO_CONFLICT_MARKER_FILE = 'no-3point-merge.md';

/** Filesystem layout + read/write of the per-feature merge run dirs and their conflict markers. */
@provideSingleton()
@injectable()
export class MergeState {
    // The per-feature "home" dir `.webpieces/merge-info/<slug>/`. It no longer holds the marker/context
    // directly — each sync gets its own numbered `merge-<n>/` run dir underneath (mergeRunDirFor),
    // paired with the sync's `<feature>PreMerge<n>` backup branch. This keeps merge N from ever reusing
    // merge N-1's stale per-file context / merge-explanation.md.
    mergeDirFor(repoRoot: string, featureName: string): string {
        return path.join(repoRoot, WEBPIECES_TMP_DIR, MERGE_INFO_DIR, featureName);
    }

    // The run dir for sync number `n`: `<home>/merge-<n>/`. Holds this sync's marker + per-file
    // `updatemain-<file>/` context. Numbered to match the sync's `<feature>PreMerge<n>` backup branch.
    mergeRunDirFor(home: string, n: number): string {
        return path.join(home, `merge-${n}`);
    }

    // The next NEVER-REUSED merge slot number for a feature home: one past the highest existing
    // `merge-<n>/` dir (or 1 if none). Durable, monotonic source of truth for slot numbers — derived
    // from the audit dirs THEMSELVES, not from which transient `<feature>PreMerge<n>` branch exists.
    nextMergeSlotNumber(home: string): number {
        if (!fs.existsSync(home)) return 1;
        let max = 0;
        for (const entry of fs.readdirSync(home)) {
            const match = entry.match(/^merge-(\d+)$/);
            if (match === null) continue;
            const n = parseInt(match[1], 10);
            if (n > max) max = n;
        }
        return max + 1;
    }

    // Write the clean-merge marker + a per-slot `updatemain-hashes.json` copy into the slot's own dir.
    writeCleanMergeMarker(mergeDir: string, forkPoint: string, featureHead: string, mainHead: string): void {
        fs.mkdirSync(mergeDir, { recursive: true });
        const body =
            '# Clean squash-merge — no 3-point conflict resolution needed\n\n' +
            'This sync merged main into the feature with no conflicts, so the AI wrote no per-file\n' +
            'merge-explanation.md. The 3-point shas below are kept so the merge is still auditable.\n\n' +
            `3-point shas:  A(fork)=${forkPoint}  B(feature)=${featureHead}  C(main)=${mainHead}\n\n` +
            'Reconstruct what each side changed:\n' +
            `  feature (B−A):  git diff ${forkPoint} ${featureHead}\n` +
            `  main    (C−A):  git diff ${forkPoint} ${mainHead}\n`;
        fs.writeFileSync(path.join(mergeDir, NO_CONFLICT_MARKER_FILE), body);
        const record = new MergeHashRecord(forkPoint, featureHead, mainHead, new Date().toISOString());
        fs.writeFileSync(path.join(mergeDir, 'updatemain-hashes.json'), JSON.stringify(record, null, 2) + '\n');
    }

    // Locate the in-progress merge's run dir: the `<home>/merge-*/` subdir holding a marker. There is
    // at most one; if more than one somehow exists, prefer an UNVALIDATED marker (the live conflict),
    // else return the first found. Null when none.
    findActiveMergeRunDir(home: string): string | null {
        if (!fs.existsSync(home)) return null;
        let fallback: string | null = null;
        for (const entry of fs.readdirSync(home)) {
            if (!entry.startsWith('merge-')) continue;
            const dir = path.join(home, entry);
            const marker = this.readMergeMarker(dir);
            if (marker === null) continue;
            if (!marker.validated) return dir;
            if (fallback === null) fallback = dir;
        }
        return fallback;
    }

    // Per-conflicted-file context dir holding A-forkpoint.txt / B-feature.txt / C-main.txt /
    // B-A.diff / C-A.diff (and the AI's merge-explanation.md). Shared so writer and reader agree on the
    // layout: the conflict file path with `/` → `__`, prefixed `updatemain-`.
    perFileContextDir(mergeDir: string, file: string): string {
        return path.join(mergeDir, `updatemain-${file.replace(/\//g, '__')}`);
    }

    markerPath(mergeDir: string): string {
        return path.join(mergeDir, MERGE_IN_PROGRESS_FILE);
    }

    readMergeMarker(mergeDir: string): MergeMarker | null {
        const filePath = this.markerPath(mergeDir);
        if (!fs.existsSync(filePath)) return null;
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as MergeMarker;
        return new MergeMarker(
            raw.currentBranch,
            raw.squashBranch,
            raw.backupBranch,
            raw.prNumber,
            raw.conflictedFiles ?? [],
            raw.forkPoint,
            raw.featureHead,
            raw.mainHead,
            raw.validated === true,
        );
    }

    writeMergeMarker(mergeDir: string, marker: MergeMarker): void {
        fs.mkdirSync(mergeDir, { recursive: true });
        fs.writeFileSync(this.markerPath(mergeDir), JSON.stringify(marker, null, 2) + '\n');
    }

    clearMergeMarker(mergeDir: string): void {
        const filePath = this.markerPath(mergeDir);
        if (fs.existsSync(filePath)) fs.rmSync(filePath);
    }

    /**
     * Scoped conflict-marker scan: reads ONLY the given conflicted files (relative to repo root),
     * never the whole repo — stays O(conflicts) regardless of monorepo size.
     */
    scanConflictMarkers(repoRoot: string, files: string[]): MarkerScanResult {
        const filesWithMarkers: string[] = [];
        for (const file of files) {
            const abs = path.join(repoRoot, file);
            if (!fs.existsSync(abs)) continue;
            const content = fs.readFileSync(abs, 'utf8');
            if (CONFLICT_MARKER_RE.test(content)) filesWithMarkers.push(file);
        }
        return new MarkerScanResult(filesWithMarkers.length === 0, filesWithMarkers);
    }

    /**
     * Explanation scan: every conflicted file the AI resolved must have a non-empty
     * MERGE_EXPLANATION_FILE in its per-file context dir (next to the diffs), proving the AI
     * deliberately 3-point merged it and recording HOW. Returns files whose explanation is missing or
     * empty. Works for every conflicted file type — including comment-less files (JSON) and files
     * resolved by deletion (no working-tree file to inspect).
     */
    scanMergeExplanations(mergeDir: string, files: string[]): MarkerScanResult {
        const filesMissingExplanation: string[] = [];
        for (const file of files) {
            const explPath = path.join(this.perFileContextDir(mergeDir, file), MERGE_EXPLANATION_FILE);
            const present = fs.existsSync(explPath) && fs.readFileSync(explPath, 'utf8').trim() !== '';
            if (!present) filesMissingExplanation.push(file);
        }
        return new MarkerScanResult(filesMissingExplanation.length === 0, filesMissingExplanation);
    }
}
