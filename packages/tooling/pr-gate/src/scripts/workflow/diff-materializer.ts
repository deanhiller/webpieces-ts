import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isPathExcluded, ReviewJsonService, toError } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { DiffBasis } from './diff-basis';

// Per-file cap. Over it, the file's diff is truncated WITH a footer naming the command that gets the rest.
export const FILE_DIFF_MAX_BYTES = 256 * 1024;
// Cap for the combined ALL.diff. Over it, whole files are omitted — again, named, never silently.
export const ALL_DIFF_MAX_BYTES = 2 * 1024 * 1024;

/** One materialized file's diff. Data-only (per CLAUDE.md). */
export class DiffManifestEntry {
    file: string;       // repo-relative source path
    diffFile: string;   // repo-relative path of the .diff under diff/files/
    status: string;     // 'M' | 'A' | 'D' | 'U' (untracked) | 'X' (excluded by config)
    bytes: number;
    truncated: boolean;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(file: string, diffFile: string, status: string, bytes: number, truncated = false) {
        this.file = file;
        this.diffFile = diffFile;
        this.status = status;
        this.bytes = bytes;
        this.truncated = truncated;
    }
}

/** The authoritative map from a mangled `.diff` name back to its real path, plus what was dropped. */
export class DiffManifest {
    base: string;
    head: string;
    dirty: boolean;
    diffCommand: string;
    entries: DiffManifestEntry[];
    excluded: string[];          // matched pr-gate.reviewDiffExclude — present, stubbed, NOT materialized
    omittedFromAllDiff: string[]; // too big for ALL.diff; their per-file .diff still exists

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        base: string, head: string, dirty: boolean, diffCommand: string,
        entries: DiffManifestEntry[] = [], excluded: string[] = [], omittedFromAllDiff: string[] = [],
    ) {
        this.base = base;
        this.head = head;
        this.dirty = dirty;
        this.diffCommand = diffCommand;
        this.entries = entries;
        this.excluded = excluded;
        this.omittedFromAllDiff = omittedFromAllDiff;
    }
}

/**
 * Extracts this branch's diff ONCE, to disk, so a reviewer subagent reads it instead of reconstructing it.
 *
 * The motivating measurement: a reviewer on monorepo-nx2 spent 14 of its 26 tool calls on context
 * archaeology, and the very first `git diff` it was told to run returned nothing (see {@link DiffBasis}).
 * Handing it a file it can simply open removes both failure modes — the empty range and the shell-out.
 *
 * Cost discipline: **two git invocations total, regardless of file count.** One `git diff` for everything,
 * split on `diff --git` headers, plus one `ls-files --others` for untracked files. A per-file `git diff`
 * loop would be N spawns for the same bytes.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is injected by type and drawn in the DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class DiffMaterializer {
    constructor(private readonly reviewJsonService: ReviewJsonService) {}

    /** The dir this writes into: `.webpieces/pr-review/<feature>/diff`. */
    diffDirFor(repoRoot: string, featureName: string): string {
        return path.join(this.reviewJsonService.prDirFor(repoRoot, featureName), 'diff');
    }

    /**
     * Write `diff/ALL.diff`, `diff/files/*.diff` and `diff/manifest.json`. Returns the manifest.
     *
     * `changedFiles` is the set the CHECKLIST MATCHING used — passed in rather than recomputed, so the diff
     * a reviewer reads covers exactly the files its checklist matched on. Recomputing here is how the two
     * would drift apart again.
     */
    materialize(repoRoot: string, featureName: string, basis: DiffBasis, changedFiles: readonly string[], excludeGlobs: readonly string[]): DiffManifest {
        const dir = this.diffDirFor(repoRoot, featureName);
        const filesDir = path.join(dir, 'files');
        fs.rmSync(dir, { recursive: true, force: true }); // a stale diff read as current is worse than none
        fs.mkdirSync(filesDir, { recursive: true });
        const manifest = new DiffManifest(basis.base, basis.headSha, basis.dirty, basis.diffCommand);
        if (basis.unresolved) return this.writeManifest(dir, manifest);
        const byFile = this.captureByFile(repoRoot, basis);
        const used = new Set<string>();
        for (const file of [...changedFiles].sort()) {
            this.writeOne(repoRoot, filesDir, file, byFile, used, excludeGlobs, manifest);
        }
        this.writeAllDiff(dir, filesDir, manifest);
        return this.writeManifest(dir, manifest);
    }

    /**
     * ONE `git diff` for the whole branch, split into per-file patches keyed by repo-relative path.
     * Untracked files never appear in `git diff`, so they are synthesized as all-added patches — the same
     * treatment DiffScope.getFileDiff already gives them, kept consistent so a reviewer sees one format.
     */
    private captureByFile(repoRoot: string, basis: DiffBasis): Map<string, string> {
        const args = basis.dirty ? ['diff', basis.base] : ['diff', basis.base, basis.headSha];
        const out = this.gitOut(repoRoot, args);
        const byFile = new Map<string, string>();
        // Split BEFORE each `diff --git` header while keeping the header on its chunk.
        for (const chunk of out.split(/\n(?=diff --git )/)) {
            if (!chunk.startsWith('diff --git ')) continue;
            const file = this.pathFromHeader(chunk);
            if (file !== '') byFile.set(file, chunk.endsWith('\n') ? chunk : `${chunk}\n`);
        }
        for (const file of this.untrackedFiles(repoRoot, basis)) {
            if (!byFile.has(file)) byFile.set(file, this.syntheticAddedDiff(repoRoot, file));
        }
        return byFile;
    }

    /**
     * The b-side path out of a `diff --git a/x b/x` header. The b-side is the right one: for a rename it is
     * the name that exists on disk, which is the file a reviewer can actually open.
     */
    private pathFromHeader(chunk: string): string {
        const header = chunk.slice(0, chunk.indexOf('\n') === -1 ? chunk.length : chunk.indexOf('\n'));
        const match = header.match(/^diff --git a\/(.+) b\/(.+)$/);
        return match ? match[2] : '';
    }

    private untrackedFiles(repoRoot: string, basis: DiffBasis): string[] {
        if (!basis.dirty) return [];
        const out = this.gitOut(repoRoot, ['ls-files', '--others', '--exclude-standard']);
        return out === '' ? [] : out.split('\n').filter((f: string): boolean => f.trim() !== '');
    }

    private syntheticAddedDiff(repoRoot: string, file: string): string {
        const abs = path.join(repoRoot, file);
        if (!fs.existsSync(abs)) return '';
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: an unreadable/binary untracked file yields a note, never a crash
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const body = fs.readFileSync(abs, 'utf8').split('\n').map((l: string): string => `+${l}`).join('\n');
            return `diff --git a/${file} b/${file}\nnew file (untracked)\n--- /dev/null\n+++ b/${file}\n${body}\n`;
        } catch (err: unknown) {
            const error = toError(err);
            void error; // a binary/unreadable untracked file gets a NOTE, never a crash
            return `diff --git a/${file} b/${file}\nnew file (untracked, unreadable as text)\n`;
        }
    }

    /** Write ONE file's diff, recording it (or its exclusion) in the manifest. Never drops a file silently. */
    // eslint-disable-next-line @typescript-eslint/max-params
    private writeOne(
        repoRoot: string, filesDir: string, file: string, byFile: Map<string, string>,
        used: Set<string>, excludeGlobs: readonly string[], manifest: DiffManifest,
    ): void {
        const name = this.safeName(file, used);
        const abs = path.join(filesDir, name);
        const rel = path.relative(repoRoot, abs);
        // Excluded files stay in the manifest and keep a stub. Dropping them entirely would read as "this
        // file did not change"; they are noise to READ, not facts to hide — and they still match checklists.
        if (excludeGlobs.length > 0 && isPathExcluded(file, [...excludeGlobs])) {
            const stub = `[excluded from materialization by pr-gate.reviewDiffExclude]\nIf you need it:  git diff ${manifest.base} -- ${file}\n`;
            fs.writeFileSync(abs, stub);
            manifest.excluded.push(file);
            manifest.entries.push(new DiffManifestEntry(file, rel, 'X', stub.length));
            return;
        }
        const raw = byFile.get(file) ?? '';
        const status = this.statusOf(file, raw, repoRoot);
        const body = this.capped(raw, file, manifest.base);
        fs.writeFileSync(abs, body);
        manifest.entries.push(new DiffManifestEntry(file, rel, status, body.length, body !== raw));
    }

    private statusOf(file: string, raw: string, repoRoot: string): string {
        if (raw.includes('\nnew file (untracked)')) return 'U';
        if (raw.includes('\nnew file mode ')) return 'A';
        if (raw.includes('\ndeleted file mode ')) return 'D';
        return fs.existsSync(path.join(repoRoot, file)) ? 'M' : 'D';
    }

    /**
     * Truncate to the cap WITH a footer. Never silently: a truncated diff that looks whole is how a reviewer
     * reports "reviewed" on a tenth of a change — the same trap `formatFileList` states its dropped count for.
     */
    private capped(raw: string, file: string, base: string): string {
        if (raw.length <= FILE_DIFF_MAX_BYTES) return raw;
        return `${raw.slice(0, FILE_DIFF_MAX_BYTES)}\n` +
            `\n… TRUNCATED at ${FILE_DIFF_MAX_BYTES} bytes (full diff is ${raw.length} bytes).\n` +
            `   Read the rest with:  git diff ${base} -- ${file}\n`;
    }

    /**
     * `ALL.diff` — the single Read that answers "what changed on this branch?". Files are appended smallest
     * first so a cap drops the fewest of them, and anything dropped is named in a footer AND in the manifest.
     */
    private writeAllDiff(dir: string, filesDir: string, manifest: DiffManifest): void {
        const ordered = [...manifest.entries].sort((a: DiffManifestEntry, b: DiffManifestEntry): number => a.bytes - b.bytes);
        const parts: string[] = [];
        let total = 0;
        for (const entry of ordered) {
            const body = fs.readFileSync(path.join(filesDir, path.basename(entry.diffFile)), 'utf8');
            if (total + body.length > ALL_DIFF_MAX_BYTES) {
                manifest.omittedFromAllDiff.push(entry.file);
                continue;
            }
            parts.push(body);
            total += body.length;
        }
        let out = parts.join('\n');
        if (manifest.omittedFromAllDiff.length > 0) {
            out += `\n\n… ${manifest.omittedFromAllDiff.length} file(s) OMITTED from this combined view (it hit the ` +
                `${ALL_DIFF_MAX_BYTES}-byte cap). Each still has its own diff under files/ — see manifest.json:\n` +
                manifest.omittedFromAllDiff.map((f: string): string => `   ${f}`).join('\n') + '\n';
        }
        fs.writeFileSync(path.join(dir, 'ALL.diff'), out);
    }

    /**
     * `a/b/c.ts` → `a__b__c.ts.diff`, reusing the SAME `/`→`__` convention MergeState.perFileContextDir
     * already uses for 3-point merge context. One mangling scheme in the repo, not two. A real `__` in a
     * path can collide, so collisions get a numeric suffix and manifest.json stays authoritative.
     */
    private safeName(file: string, used: Set<string>): string {
        const flat = `${file.replace(/\//g, '__')}.diff`;
        if (!used.has(flat)) {
            used.add(flat);
            return flat;
        }
        for (let n = 2; ; n++) {
            const candidate = `${file.replace(/\//g, '__')}-${n}.diff`;
            if (!used.has(candidate)) {
                used.add(candidate);
                return candidate;
            }
        }
    }

    private writeManifest(dir: string, manifest: DiffManifest): DiffManifest {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
        return manifest;
    }

    private gitOut(repoRoot: string, args: string[]): string {
        // maxBuffer: a monorepo diff routinely exceeds node's 1MB default, and the failure mode is a
        // truncated capture that looks like a complete one.
        const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
        return result.status === 0 ? (result.stdout ?? '') : '';
    }
}
