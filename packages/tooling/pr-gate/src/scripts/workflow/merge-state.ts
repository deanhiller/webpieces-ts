import * as fs from 'fs';
import * as path from 'path';
import {
    WEBPIECES_TMP_DIR,
    MERGE_DIR_PREFIX,
    MERGE_IN_PROGRESS_FILE,
    MERGE_EXPLANATION_FILE,
} from '@webpieces/rules-config';

// Proof-obligation marker written when a 3-point squash-merge hits conflicts. Its mere
// presence (with validated=false) is what the merge-in-progress-guard hook uses to block
// commit/push/PR until `wp-git-merge-complete` validates the resolution and flips it true.
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

const CONFLICT_MARKER_RE = /^(<{7}|={7}|>{7})/m;

export function mergeDirFor(repoRoot: string, featureName: string): string {
    return path.join(repoRoot, WEBPIECES_TMP_DIR, `${MERGE_DIR_PREFIX}${featureName}`);
}

// Per-conflicted-file context dir holding A-forkpoint.txt / B-feature.txt / C-main.txt /
// B-A.diff / C-A.diff (and the AI's merge-explanation.md). Shared so the writer
// (saveConflictContext) and the reader (the explanation gate) agree on the layout: the conflict
// file path with `/` → `__`, prefixed `updatemain-`.
export function perFileContextDir(mergeDir: string, file: string): string {
    return path.join(mergeDir, `updatemain-${file.replace(/\//g, '__')}`);
}

export function markerPath(mergeDir: string): string {
    return path.join(mergeDir, MERGE_IN_PROGRESS_FILE);
}

export function readMergeMarker(mergeDir: string): MergeMarker | null {
    const filePath = markerPath(mergeDir);
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

export function writeMergeMarker(mergeDir: string, marker: MergeMarker): void {
    fs.mkdirSync(mergeDir, { recursive: true });
    fs.writeFileSync(markerPath(mergeDir), JSON.stringify(marker, null, 2) + '\n');
}

export function clearMergeMarker(mergeDir: string): void {
    const filePath = markerPath(mergeDir);
    if (fs.existsSync(filePath)) fs.rmSync(filePath);
}

/**
 * Scoped conflict-marker scan: reads ONLY the given conflicted files (relative to repo
 * root), never the whole repo — stays O(conflicts) regardless of monorepo size.
 */
export function scanConflictMarkers(repoRoot: string, files: string[]): MarkerScanResult {
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
 * MERGE_EXPLANATION_FILE sitting in its per-file context dir (next to the diffs), proving the AI
 * deliberately 3-point merged it and recording HOW. Returns the files whose explanation is
 * missing or empty. Works for every conflicted file regardless of type — including comment-less
 * files (JSON) and files resolved by deletion (no working-tree file to inspect).
 */
export function scanMergeExplanations(mergeDir: string, files: string[]): MarkerScanResult {
    const filesMissingExplanation: string[] = [];
    for (const file of files) {
        const explPath = path.join(perFileContextDir(mergeDir, file), MERGE_EXPLANATION_FILE);
        const present = fs.existsSync(explPath) && fs.readFileSync(explPath, 'utf8').trim() !== '';
        if (!present) filesMissingExplanation.push(file);
    }
    return new MarkerScanResult(filesMissingExplanation.length === 0, filesMissingExplanation);
}
