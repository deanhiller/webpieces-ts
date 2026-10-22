import { specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PrGateFeature } from '../../__tests__/feature-harness';
import { DiffBasis } from './diff-basis';
import { DiffManifestEntry, DiffMaterializer, FILE_DIFF_MAX_BYTES } from './diff-materializer';

/**
 * DiffMaterializer from the shipped container, with git SCRIPTED (#1381). The materializer asks git for
 * ONE whole-branch `git diff` (plus the untracked list on a dirty tree) and splits it into per-file
 * patches; the scripted output below is what git prints for each change, so what is under test is the
 * split, the synthesis, the stubbing and the truncation — never git.
 */

const BASE = 'b'.repeat(40);
const HEAD = 'h'.repeat(40);
const dirs: string[] = [];
let feature: PrGateFeature;

beforeEach(async () => {
    feature = await PrGateFeature.create();
});

afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function repo(): string {
    const dir = specTempDirs.make('wp-mat-');
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'keep.ts'), 'keep\n');
    return dir;
}

/** What `git diff` prints for one modified file. */
function modified(file: string, before: string[], after: string[]): string {
    return `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n`
        + `@@ -1,${before.length} +1,${after.length} @@\n`
        + before.map((l: string): string => `-${l}\n`).join('') + after.map((l: string): string => `+${l}\n`).join('');
}

/** What `git diff` prints for one added file. */
function added(file: string, lines: string[]): string {
    return `diff --git a/${file} b/${file}\nnew file mode 100644\nindex 0000000..3333333\n--- /dev/null\n+++ b/${file}\n`
        + `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l: string): string => `+${l}\n`).join('');
}

/** What `git diff` prints for one deleted file. */
function deleted(file: string, lines: string[]): string {
    return `diff --git a/${file} b/${file}\ndeleted file mode 100644\nindex 4444444..0000000\n--- a/${file}\n+++ /dev/null\n`
        + `@@ -1,${lines.length} +0,0 @@\n` + lines.map((l: string): string => `-${l}\n`).join('');
}

/** A clean branch whose commits since BASE print `diff`. */
function committed(dir: string, diff: string): DiffBasis {
    feature.git.respond(['diff', BASE, HEAD], feature.git.ok(diff));
    return new DiffBasis(BASE, HEAD, false, [], `git diff ${BASE} ${HEAD}`, `git diff ${BASE} ${HEAD} -- <file>`);
}

/** A DIRTY tree: `git diff BASE` prints `diff`, and `untracked` are the files git does not track yet. */
function dirty(diff: string, untracked: string[]): DiffBasis {
    feature.git.respond(['diff', BASE], feature.git.ok(diff));
    feature.git.respond(['ls-files', '--others', '--exclude-standard'], feature.git.ok(untracked.map((f: string): string => `${f}\n`).join('')));
    return new DiffBasis(BASE, HEAD, true, untracked, `git diff ${BASE}`, `git diff ${BASE} -- <file>`);
}

function materializer(): DiffMaterializer {
    return feature.container.get(DiffMaterializer);
}

function entryFor(entries: readonly DiffManifestEntry[], file: string): DiffManifestEntry {
    const found = entries.find((e: DiffManifestEntry): boolean => e.file === file);
    if (!found) throw new Error(`no manifest entry for ${file}`);
    return found;
}

describe('DiffMaterializer — one extraction, many readers', () => {
    it('writes a per-file diff, a combined ALL.diff, and a manifest', async () => {
        const dir = repo();
        fs.mkdirSync(path.join(dir, 'src', 'nested'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'src', 'nested', 'deep.ts'), 'NEW_CONTENT\n');
        const basis = committed(dir, modified('src/keep.ts', ['keep'], ['keep', 'CHANGED']) + added('src/nested/deep.ts', ['NEW_CONTENT']));

        const files = ['src/keep.ts', 'src/nested/deep.ts'];
        const manifest = await materializer().materialize(dir, 'feat', basis, files, []);
        const diffDir = materializer().diffDirFor(dir, 'feat');

        expect(manifest.entries).toHaveLength(2);
        // The '/' -> '__' convention is REUSED from MergeState.perFileContextDir — one mangling scheme in
        // the repo, not two.
        expect(fs.existsSync(path.join(diffDir, 'files', 'src__nested__deep.ts.diff'))).toBe(true);
        expect(entryFor(manifest.entries, 'src/nested/deep.ts').status).toBe('A');
        const all = fs.readFileSync(path.join(diffDir, 'ALL.diff'), 'utf8');
        expect(all).toContain('NEW_CONTENT');
        expect(all).toContain('CHANGED');
        expect(fs.existsSync(path.join(diffDir, 'manifest.json'))).toBe(true);
        // ONE git call for the whole branch, never one per file.
        expect(feature.git.commandLines()).toEqual([`git diff ${BASE} ${HEAD}`]);
    });

    // The whole point of materializing: the reviewer opens a file instead of shelling out per file.
    it('each per-file diff really contains that file\'s change', async () => {
        const dir = repo();
        const basis = committed(dir, modified('src/keep.ts', ['keep'], ['keep', 'ONLY_IN_KEEP']) + added('src/other.ts', ['OTHER']));

        const manifest = await materializer().materialize(dir, 'feat', basis, ['src/keep.ts'], []);
        const body = fs.readFileSync(path.join(dir, entryFor(manifest.entries, 'src/keep.ts').diffFile), 'utf8');
        expect(body).toContain('ONLY_IN_KEEP');
        expect(body).not.toContain('OTHER');
    });

    // An UNTRACKED file never appears in `git diff`, so it is synthesized as an all-added patch. Without
    // this, brand-new files — the ones a checklist most wants to see — would materialize as empty.
    it('synthesizes an all-added diff for an untracked file', async () => {
        const dir = repo();
        fs.writeFileSync(path.join(dir, 'src', 'brand-new.ts'), 'BRAND_NEW_LINE\n');
        const basis = dirty('', ['src/brand-new.ts']);

        const manifest = await materializer().materialize(dir, 'feat', basis, ['src/brand-new.ts'], []);
        const entry = entryFor(manifest.entries, 'src/brand-new.ts');
        expect(entry.status).toBe('U');
        expect(fs.readFileSync(path.join(dir, entry.diffFile), 'utf8')).toContain('+BRAND_NEW_LINE');
    });

    // A DELETED file must materialize as a real removal patch — a reviewer judging a deleted auth check
    // needs to see what was in it.
    it('materializes a deletion as a removal patch', async () => {
        const dir = repo();
        fs.rmSync(path.join(dir, 'src', 'keep.ts'));
        const basis = committed(dir, deleted('src/keep.ts', ['keep']));

        const manifest = await materializer().materialize(dir, 'feat', basis, ['src/keep.ts'], []);
        const entry = entryFor(manifest.entries, 'src/keep.ts');
        expect(entry.status).toBe('D');
        // No source path: a deleted file has no after-state to open, and a path that cannot resolve turns
        // straight back into a search.
        expect(entry.fileAbs).toBe('');
        expect(fs.readFileSync(path.join(dir, entry.diffFile), 'utf8')).toContain('-keep');
    });
});

// Split out to keep each describe under the method-length limit.
describe('DiffMaterializer — nothing is ever dropped silently', () => {
    /**
     * Excluded files are STUBBED, never dropped. Removing them outright would read as "this file did not
     * change" — a different and false claim — and they still match checklists, so the manifest must
     * account for them.
     */
    it('stubs an excluded file instead of dropping it, and still lists it', async () => {
        const dir = repo();
        const basis = committed(dir, added('generated.json', ['{"regenerated": true}']));

        const manifest = await materializer().materialize(dir, 'feat', basis, ['generated.json'], ['**/generated.json']);
        expect(manifest.excluded).toEqual(['generated.json']);
        const entry = entryFor(manifest.entries, 'generated.json');
        expect(entry.status).toBe('X');
        const body = fs.readFileSync(path.join(dir, entry.diffFile), 'utf8');
        expect(body).toContain('excluded from materialization');
        // …and it names the command that gets the real thing. A stub that dead-ends is worse than none.
        expect(body).toContain('git diff');
    });

    /**
     * Truncation is NEVER silent. A truncated diff that looks whole is how a reviewer reports "reviewed"
     * having seen a tenth of a change — the same trap formatFileList states its dropped count for.
     */
    it('states truncation in the file AND in the manifest', async () => {
        const dir = repo();
        const huge = 'x'.repeat(FILE_DIFF_MAX_BYTES + 5000).split('');
        const basis = committed(dir, added('src/huge.ts', huge));

        const manifest = await materializer().materialize(dir, 'feat', basis, ['src/huge.ts'], []);
        const entry = entryFor(manifest.entries, 'src/huge.ts');
        expect(entry.truncated).toBe(true);
        const body = fs.readFileSync(path.join(dir, entry.diffFile), 'utf8');
        expect(body).toContain('TRUNCATED');
        expect(body).toContain('git diff');
    });

    /**
     * The incompleteness notice must be at the TOP of ALL.diff. As a footer it was unreachable exactly when
     * it mattered: the cap is 2 MB (~30-50k lines) and a Read truncates at ~2000, so on the one PR where
     * files were dropped the reviewer got the first ~5% and the notice sat in the 95% it never reached.
     */
    it('puts the incompleteness notice at the TOP of ALL.diff, where a truncated Read still sees it', async () => {
        const dir = repo();
        const huge = 'x'.repeat(FILE_DIFF_MAX_BYTES + 5000).split('');
        const basis = committed(dir, added('src/huge.ts', huge));

        await materializer().materialize(dir, 'feat', basis, ['src/huge.ts'], []);
        const all = fs.readFileSync(path.join(materializer().diffDirFor(dir, 'feat'), 'ALL.diff'), 'utf8');
        expect(all.split('\n')[0]).toContain('THIS COMBINED VIEW IS INCOMPLETE');
        expect(all).toContain('src/huge.ts');
    });

    // A complete view gets NO header: a notice on every diff trains a reader to skip the notice.
    it('emits no header when nothing was truncated or omitted, and measures the view once', async () => {
        const dir = repo();
        const basis = committed(dir, modified('src/keep.ts', ['keep'], ['keep', 'CHANGED']));

        const manifest = await materializer().materialize(dir, 'feat', basis, ['src/keep.ts'], []);
        const all = fs.readFileSync(path.join(materializer().diffDirFor(dir, 'feat'), 'ALL.diff'), 'utf8');
        expect(all).not.toContain('INCOMPLETE');
        // Measured HERE so the instructions renderer reads one number instead of running its own `wc -l`.
        expect(manifest.allDiffBytes).toBe(all.length);
        expect(manifest.allDiffLines).toBe(all.split('\n').length);
    });

    /**
     * Both paths, relative AND absolute. Relative is the identity that survives a re-clone; absolute is the
     * only form a reviewer subagent can open, since its cwd is not guaranteed to be the repo root. A deleted
     * file gets no source path at all — it has no after-state to open.
     */
    it('records an absolute path for the source and the diff', async () => {
        const dir = repo();
        const basis = committed(dir, modified('src/keep.ts', ['keep'], ['keep', 'CHANGED']));

        const manifest = await materializer().materialize(dir, 'feat', basis, ['src/keep.ts'], []);
        const entry = entryFor(manifest.entries, 'src/keep.ts');
        expect(entry.fileAbs).toBe(path.join(dir, 'src', 'keep.ts'));
        expect(path.isAbsolute(entry.diffAbs)).toBe(true);
        expect(fs.existsSync(entry.diffAbs)).toBe(true);
    });

    // A stale diff read as current is worse than none, so a re-run must not leave last run's files behind.
    it('clears a previous run rather than merging into it', async () => {
        const dir = repo();
        const basis = committed(dir, modified('src/keep.ts', ['keep'], ['keep', 'first']));
        await materializer().materialize(dir, 'feat', basis, ['src/keep.ts'], []);

        const stale = path.join(materializer().diffDirFor(dir, 'feat'), 'files', 'src__gone.ts.diff');
        fs.writeFileSync(stale, 'STALE\n');
        await materializer().materialize(dir, 'feat', basis, ['src/keep.ts'], []);
        expect(fs.existsSync(stale)).toBe(false);
    });

    // No fork point ⇒ nothing to extract, but a manifest is still written so a reader can tell the
    // difference between "never run" and "run, found nothing".
    it('writes an empty manifest rather than nothing when the base is unresolvable', async () => {
        const dir = repo();

        const manifest = await materializer().materialize(dir, 'feat', new DiffBasis('', HEAD), ['a.txt'], []);
        expect(manifest.entries).toEqual([]);
        expect(fs.existsSync(path.join(materializer().diffDirFor(dir, 'feat'), 'manifest.json'))).toBe(true);
        // With no base there is nothing to ask git.
        expect(feature.git.calls).toEqual([]);
    });
});
