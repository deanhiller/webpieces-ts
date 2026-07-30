import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReviewJsonService } from '@webpieces/rules-config';
import { DiffBasis, DiffBasisResolver } from './diff-basis';
import { DiffManifestEntry, DiffMaterializer, FILE_DIFF_MAX_BYTES } from './diff-materializer';
import { ForkPoint } from './git-findForkPoint';

const dirs: string[] = [];

afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, cmd: string): void {
    execSync(cmd, { cwd, stdio: 'pipe' });
}

function repoOnFeatureBranch(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-mat-'));
    dirs.push(dir);
    git(dir, 'git init -q -b main');
    git(dir, 'git config user.email t@t.t && git config user.name t');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'keep.ts'), 'keep\n');
    git(dir, 'git add -A && git commit -q -m base');
    git(dir, 'git checkout -q -b feat');
    return dir;
}

function materializerFor(): DiffMaterializer {
    return new DiffMaterializer(new ReviewJsonService());
}

function basisFor(dir: string): DiffBasis {
    return new DiffBasisResolver(new ForkPoint(null as never, null as never, null as never)).resolve(dir);
}

function entryFor(entries: readonly DiffManifestEntry[], file: string): DiffManifestEntry {
    const found = entries.find((e: DiffManifestEntry): boolean => e.file === file);
    if (!found) throw new Error(`no manifest entry for ${file}`);
    return found;
}

describe('DiffMaterializer — one extraction, many readers', () => {
    it('writes a per-file diff, a combined ALL.diff, and a manifest', () => {
        const dir = repoOnFeatureBranch();
        fs.mkdirSync(path.join(dir, 'src', 'nested'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'src', 'nested', 'deep.ts'), 'NEW_CONTENT\n');
        fs.writeFileSync(path.join(dir, 'src', 'keep.ts'), 'keep\nCHANGED\n');
        git(dir, 'git add -A && git commit -q -m work');

        const files = ['src/keep.ts', 'src/nested/deep.ts'];
        const manifest = materializerFor().materialize(dir, 'feat', basisFor(dir), files, []);
        const diffDir = materializerFor().diffDirFor(dir, 'feat');

        expect(manifest.entries).toHaveLength(2);
        // The '/' -> '__' convention is REUSED from MergeState.perFileContextDir — one mangling scheme in
        // the repo, not two.
        expect(fs.existsSync(path.join(diffDir, 'files', 'src__nested__deep.ts.diff'))).toBe(true);
        const all = fs.readFileSync(path.join(diffDir, 'ALL.diff'), 'utf8');
        expect(all).toContain('NEW_CONTENT');
        expect(all).toContain('CHANGED');
        expect(fs.existsSync(path.join(diffDir, 'manifest.json'))).toBe(true);
    });

    // The whole point of materializing: the reviewer opens a file instead of shelling out per file.
    it('each per-file diff really contains that file\'s change', () => {
        const dir = repoOnFeatureBranch();
        fs.writeFileSync(path.join(dir, 'src', 'keep.ts'), 'keep\nONLY_IN_KEEP\n');
        git(dir, 'git add -A && git commit -q -m work');

        const manifest = materializerFor().materialize(dir, 'feat', basisFor(dir), ['src/keep.ts'], []);
        const entry = entryFor(manifest.entries, 'src/keep.ts');
        expect(fs.readFileSync(path.join(dir, entry.diffFile), 'utf8')).toContain('ONLY_IN_KEEP');
    });

    // An UNTRACKED file never appears in `git diff`, so it is synthesized as an all-added patch. Without
    // this, brand-new files — the ones a checklist most wants to see — would materialize as empty.
    it('synthesizes an all-added diff for an untracked file', () => {
        const dir = repoOnFeatureBranch();
        fs.writeFileSync(path.join(dir, 'src', 'brand-new.ts'), 'BRAND_NEW_LINE\n');

        const manifest = materializerFor().materialize(dir, 'feat', basisFor(dir), ['src/brand-new.ts'], []);
        const entry = entryFor(manifest.entries, 'src/brand-new.ts');
        expect(entry.status).toBe('U');
        expect(fs.readFileSync(path.join(dir, entry.diffFile), 'utf8')).toContain('+BRAND_NEW_LINE');
    });

    // A DELETED file must materialize as a real removal patch — a reviewer judging a deleted auth check
    // needs to see what was in it.
    it('materializes a deletion as a removal patch', () => {
        const dir = repoOnFeatureBranch();
        git(dir, 'git rm -q src/keep.ts');
        git(dir, 'git commit -q -m delete');

        const manifest = materializerFor().materialize(dir, 'feat', basisFor(dir), ['src/keep.ts'], []);
        const entry = entryFor(manifest.entries, 'src/keep.ts');
        expect(entry.status).toBe('D');
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
    it('stubs an excluded file instead of dropping it, and still lists it', () => {
        const dir = repoOnFeatureBranch();
        fs.writeFileSync(path.join(dir, 'generated.json'), '{"regenerated": true}\n');
        git(dir, 'git add -A && git commit -q -m gen');

        const manifest = materializerFor().materialize(
            dir, 'feat', basisFor(dir), ['generated.json'], ['**/generated.json']);
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
    it('states truncation in the file AND in the manifest', () => {
        const dir = repoOnFeatureBranch();
        const huge = 'x'.repeat(FILE_DIFF_MAX_BYTES + 5000).split('').join('\n');
        fs.writeFileSync(path.join(dir, 'src', 'huge.ts'), huge);
        git(dir, 'git add -A && git commit -q -m huge');

        const manifest = materializerFor().materialize(dir, 'feat', basisFor(dir), ['src/huge.ts'], []);
        const entry = entryFor(manifest.entries, 'src/huge.ts');
        expect(entry.truncated).toBe(true);
        const body = fs.readFileSync(path.join(dir, entry.diffFile), 'utf8');
        expect(body).toContain('TRUNCATED');
        expect(body).toContain('git diff');
    });

    // A stale diff read as current is worse than none, so a re-run must not leave last run's files behind.
    it('clears a previous run rather than merging into it', () => {
        const dir = repoOnFeatureBranch();
        fs.writeFileSync(path.join(dir, 'src', 'keep.ts'), 'keep\nfirst\n');
        git(dir, 'git add -A && git commit -q -m first');
        materializerFor().materialize(dir, 'feat', basisFor(dir), ['src/keep.ts'], []);

        const stale = path.join(materializerFor().diffDirFor(dir, 'feat'), 'files', 'src__gone.ts.diff');
        fs.writeFileSync(stale, 'STALE\n');
        materializerFor().materialize(dir, 'feat', basisFor(dir), ['src/keep.ts'], []);
        expect(fs.existsSync(stale)).toBe(false);
    });

    // No fork point ⇒ nothing to extract, but a manifest is still written so a reader can tell the
    // difference between "never run" and "run, found nothing".
    it('writes an empty manifest rather than nothing when the base is unresolvable', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-mat-nomain-'));
        dirs.push(dir);
        git(dir, 'git init -q -b solo');
        git(dir, 'git config user.email t@t.t && git config user.name t');
        fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
        git(dir, 'git add -A && git commit -q -m only');

        const manifest = materializerFor().materialize(dir, 'feat', basisFor(dir), ['a.txt'], []);
        expect(manifest.entries).toEqual([]);
        expect(fs.existsSync(path.join(materializerFor().diffDirFor(dir, 'feat'), 'manifest.json'))).toBe(true);
    });
});
