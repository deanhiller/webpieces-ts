import * as nodePath from 'path';

import { ExcludePaths } from '@webpieces/rules-config';

import { CommandScanner } from './command-scan';
import { ExcludedPathEscapeHint, ExcludedPathEscapeScan, ExcludedPathReference } from './excluded-path-escape';
import { globMatches } from './load-rules';

const ROOT = '/repo';

function scanAt(effectiveCwd: string = ROOT): ExcludedPathEscapeScan {
    return new ExcludedPathEscapeScan(new CommandScanner(), ROOT, effectiveCwd);
}

function hintAt(effectiveCwd: string = ROOT): ExcludedPathEscapeHint {
    return new ExcludedPathEscapeHint(ROOT, effectiveCwd);
}

const DOT_WEBPIECES = new ExcludePaths(['.webpieces/**']);
const REPOSITORIES = new ExcludePaths(['repositories/**']);

function paths(refs: readonly ExcludedPathReference[]): string[] {
    return refs.map((r: ExcludedPathReference): string => r.referencedPath);
}

describe('ExcludedPathEscapeScan — which paths did the denied command actually name?', () => {
    it('finds the operand of a plain reader', () => {
        expect(paths(scanAt().references('cat .webpieces/tasks.md', DOT_WEBPIECES))).toEqual(['.webpieces/tasks.md']);
    });

    it('finds a path that is NOT the first operand (grep pattern first)', () => {
        expect(paths(scanAt().references('grep -n foo .webpieces/tasks.md', DOT_WEBPIECES)))
            .toEqual(['.webpieces/tasks.md']);
    });

    it("finds a path behind a quoted sed script — the '1,5p' token is not a path and matches nothing", () => {
        expect(paths(scanAt().references("sed -n '1,5p' .webpieces/tasks.md", DOT_WEBPIECES)))
            .toEqual(['.webpieces/tasks.md']);
    });

    it('scans EVERY segment of an && compound, not just the first', () => {
        expect(paths(scanAt().references('pnpm nx run x:test && cat .webpieces/tasks.md', DOT_WEBPIECES)))
            .toEqual(['.webpieces/tasks.md']);
    });

    it('normalises an ABSOLUTE path to workspace-relative before matching', () => {
        // The exact shape of the live incident: `cat /Users/…/monorepo-nx2/.webpieces/tasks.md`.
        expect(paths(scanAt().references(`cat ${nodePath.join(ROOT, '.webpieces', 'tasks.md')}`, DOT_WEBPIECES)))
            .toEqual(['.webpieces/tasks.md']);
    });

    it('resolves a RELATIVE path against the effective cwd, not the workspace root', () => {
        expect(paths(scanAt(nodePath.join(ROOT, '.webpieces')).references('cat tasks.md', DOT_WEBPIECES)))
            .toEqual(['.webpieces/tasks.md']);
    });

    it('strips a glued redirection operator so the target is seen as the path it is', () => {
        expect(paths(scanAt().references('echo x >.webpieces/tasks.md', DOT_WEBPIECES)))
            .toEqual(['.webpieces/tasks.md']);
    });

    it('de-duplicates a path named twice', () => {
        expect(paths(scanAt().references('cat .webpieces/tasks.md && wc -l .webpieces/tasks.md', DOT_WEBPIECES)))
            .toEqual(['.webpieces/tasks.md']);
    });

    it('ignores paths OUTSIDE the workspace and ~-rooted ones', () => {
        expect(scanAt().references('cat /etc/hosts ~/.zshrc /tmp/out.log', DOT_WEBPIECES)).toEqual([]);
    });

    it('finds nothing when the command names no excluded path', () => {
        expect(scanAt().references('cat src/app/service.ts', DOT_WEBPIECES)).toEqual([]);
    });

    it('finds nothing when no exclusions are configured at all', () => {
        expect(scanAt().references('cat .webpieces/tasks.md', new ExcludePaths([]))).toEqual([]);
    });

    it('reports WHICH glob matched, so the agent need not re-derive it', () => {
        const ex = new ExcludePaths(['vendor/**', 'repositories/**']);
        expect(scanAt().references('cat repositories/fuji/src/x.ts', ex)[0].matchedGlob).toBe('repositories/**');
    });
});

describe('ExcludedPathEscapeScan — the cd it offers must satisfy the runner\'s OWN matcher', () => {
    it('offers the containing directory when that directory itself matches a glob', () => {
        const ref = scanAt().references('cat repositories/fuji/notes.md', REPOSITORIES)[0];
        expect(ref.cdDirectory).toBe('repositories/fuji');
        expect(ref.pathFromCdDirectory).toBe('notes.md');
    });

    // The trap in the ticket, asserted rather than eyeballed: `.webpieces/**` compiles to an anchored
    // /^\.webpieces\/.*$/, so the BARE directory fails its own glob and `cd .webpieces && cat tasks.md`
    // would still be denied. Offering it would be worse than offering nothing.
    it('offers NO cd when the containing directory fails the glob (the <dir>/** trap)', () => {
        const ref = scanAt().references('cat .webpieces/tasks.md', DOT_WEBPIECES)[0];
        expect(globMatches('.webpieces/**', '.webpieces')).toBe(false);   // the trap, stated
        expect(ref.cdDirectory).toBeNull();
    });

    it('every offered cd directory PASSES globMatches against a configured glob', () => {
        const ex = new ExcludePaths(['.webpieces/**', 'repositories/**', 'vendor']);
        const command = 'cat .webpieces/tasks.md repositories/fuji/a.ts repositories/b.ts vendor/lib/c.ts';
        const offered = scanAt().references(command, ex)
            .map((r: ExcludedPathReference): string | null => r.cdDirectory)
            .filter((d: string | null): boolean => d !== null);

        expect(offered.length).toBeGreaterThan(0);
        for (const dir of offered) {
            expect(ex.paths.some((p: string): boolean => globMatches(p, String(dir)))).toBe(true);
        }
    });
});

describe('ExcludedPathEscapeHint — the stanza', () => {
    it('is empty when the command names no excluded path (no noise)', () => {
        expect(hintAt().render('cat src/app/service.ts', DOT_WEBPIECES)).toBe('');
    });

    it('names the ACTUAL configured globs, the matched path, and the Read/Write escape', () => {
        const ex = new ExcludePaths(['vendor/**', 'repositories/**']);
        const stanza = hintAt().render('cat repositories/fuji/notes.md', ex);
        expect(stanza).toContain('READ/WRITE TOOLS RIGHT NOW');
        expect(stanza).toContain('vendor/**');
        expect(stanza).toContain('repositories/**');
        expect(stanza).toContain('Your command referenced: repositories/fuji/notes.md');
    });

    it('prints the cd form when one is legal', () => {
        const stanza = hintAt().render('cat repositories/fuji/notes.md', REPOSITORIES);
        expect(stanza).toContain('cd repositories/fuji &&');
        expect(stanza).toContain('LEADING `cd`');
    });

    it('refuses to invent a cd when none matches, and names the config edit that would create one', () => {
        const stanza = hintAt().render('cat .webpieces/tasks.md', DOT_WEBPIECES);
        expect(stanza).not.toContain('cd .webpieces &&');
        expect(stanza).toContain('A `cd` CANNOT rescue bash here');
        expect(stanza).toContain('[".webpieces", ".webpieces/**"]');
    });
});
