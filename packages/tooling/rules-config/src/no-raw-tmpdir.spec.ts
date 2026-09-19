import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * EVERY `$TMPDIR` SCRATCH TREE GOES THROUGH AN OWNER.
 *
 * A raw `fs.mkdtempSync(path.join(os.tmpdir(), ...))` is a directory nothing will ever remove, and 212
 * of them across `packages/tooling/**` produced a measured 270,200 abandoned `wp-*` directories on one
 * developer machine. The cure was `SpecTempDirs` (fixtures) and `RepoScratchDirs` (runtime), and this
 * test is what stops the 197th from being written — an `afterAll` somebody has to remember is exactly
 * the discipline that already failed here.
 *
 * It asserts over SOURCE TEXT, which is normally the weaker kind of check, and that is the right trade
 * for this one: the defect is a call that is never made at runtime by anything the suite exercises, so
 * there is no behaviour to observe. The two files below are the implementations themselves.
 */
const ALLOWED = ['spec-temp-dirs.ts', 'tmp-scratch-sweep.ts', 'no-raw-tmpdir.spec.ts'];

// Any spelling: `path.join` or an alias, and `os.tmpdir()` either bare or wrapped in `realpathSync`.
// The first cut of this matched only `path.join(os.tmpdir()` and missed 16 live call sites.
const RAW_TMPDIR = /mkdtempSync\s*\(\s*\w*[Pp]ath\.join\s*\(\s*(?:fs\.realpathSync\(\s*)?os\.tmpdir\s*\(\s*\)/;

/**
 * Comments are not call sites, and this file's own neighbours explain the defect in prose that names
 * the banned shape. Stripping them is what lets the rule be DOCUMENTED where it is enforced.
 */
class CommentFreeSource {
    read(file: string): string {
        return fs.readFileSync(file, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '');
    }
}

class SourceFiles {
    collect(dir: string, found: string[] = []): string[] {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== 'node_modules' && entry.name !== 'dist') this.collect(full, found);
            } else if (entry.name.endsWith('.ts')) {
                found.push(full);
            }
        }
        return found;
    }
}

describe('no raw os.tmpdir() scratch directories in packages/tooling', () => {
    it('every mkdtemp under os.tmpdir() goes through SpecTempDirs or RepoScratchDirs', () => {
        const toolingRoot = path.resolve(__dirname, '..', '..');
        const offenders = new SourceFiles().collect(toolingRoot)
            .filter((file: string): boolean => !ALLOWED.includes(path.basename(file)))
            .filter((file: string): boolean => RAW_TMPDIR.test(new CommentFreeSource().read(file)))
            .map((file: string): string => path.relative(toolingRoot, file));

        expect(offenders, [
            'These files mint a $TMPDIR directory nothing will reap.',
            'Use `specTempDirs.make(prefix)` in a spec or testkit, or inject `RepoScratchDirs`',
            'and call `make(repoRoot, prefix)` in runtime code so `CleanTmp` owns it.',
        ].join(' ')).toEqual([]);
    });

    // Pins the detector in the positive direction, so it cannot rot into decoration that always passes.
    it('the detector actually matches the shape it is banning', () => {
        expect(RAW_TMPDIR.test("fs.mkdtempSync(path.join(os.tmpdir(), 'wp-x-'))")).toBe(true);
        expect(RAW_TMPDIR.test("fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp-x-'))")).toBe(true);
        expect(RAW_TMPDIR.test("fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wp-x-'))")).toBe(true);
        expect(RAW_TMPDIR.test("specTempDirs.make('wp-x-')")).toBe(false);
        expect(RAW_TMPDIR.test("specTempDirs.makeReal('wp-x-')")).toBe(false);
    });
});
