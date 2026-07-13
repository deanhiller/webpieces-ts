import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isBrokenTreeError, recoveryNotice } from './install-entry';
import { renderShim, shimPath, healShim, findShimRoot, RECOVERY_CMD } from './shim';

function mktmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-install-'));
}

// Stage a repo whose committed shim is STALE (an old fail-open body), which is exactly the state a
// consumer is in before upgrading: the shipped shim exec'd the bin and could not fail closed.
function rootWithStaleShim(): string {
    const root = mktmp();
    const target = shimPath(root);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '#!/bin/sh\nexec "$1"\n', { mode: 0o755 });
    return root;
}

// The whole point of install-entry: the installer must survive a corrupt node_modules, because that is
// the ONLY situation in which it is needed. setup.ts top-level-imports @webpieces/rules-config →
// minimatch, so requiring it on a broken tree throws MODULE_NOT_FOUND at load time and the installer
// used to die there — repairing nothing and printing a raw node loader trace.
describe('install-entry — surviving a corrupt node_modules', () => {
    it('classifies a MODULE_NOT_FOUND as a broken tree (relative OR bare specifier)', () => {
        // A package's own file missing from disk — the corruption we actually hit.
        const relative = Object.assign(new Error("Cannot find module './assert-valid-pattern.js'"), { code: 'MODULE_NOT_FOUND' });
        // A package not installed at all — same cure, so it must classify the same way.
        const bare = Object.assign(new Error("Cannot find module '@webpieces/rules-config'"), { code: 'MODULE_NOT_FOUND' });
        expect(isBrokenTreeError(relative)).toBe(true);
        expect(isBrokenTreeError(bare)).toBe(true);
    });

    it('does NOT classify a real bug as a broken tree (it must be re-thrown, never prettified away)', () => {
        expect(isBrokenTreeError(new TypeError('x is not a function'))).toBe(false);
        expect(isBrokenTreeError(new Error('plain'))).toBe(false);
        expect(isBrokenTreeError(Object.assign(new Error('nope'), { code: 'EACCES' }))).toBe(false);
    });

    it('prints the ONE command that repairs it — not a node loader trace', () => {
        const text = recoveryNotice("Cannot find module './assert-valid-pattern.js'", true).join('\n');
        expect(text).toContain(RECOVERY_CMD);                       // rm -rf node_modules && pnpm install
        expect(text).toContain('assert-valid-pattern');             // the real cause, surfaced
        // The trap that wasted the most time: pnpm reports "up to date" and skips the broken package.
        expect(text).toContain('will NOT fix it');
        expect(text).toContain('[31;1m');                         // ANSI red — must not scroll past unseen
    });

    it('tells the truth about whether the fail-closed gate got re-armed', () => {
        expect(recoveryNotice('boom', true).join('\n')).toContain('shim WAS refreshed');
        expect(recoveryNotice('boom', false).join('\n')).toContain('No committed shim was found');
    });

    // THE payoff. On a corrupt tree, step 1 (healShim) still runs because ./shim imports only fs+path.
    // That upgrades a stale fail-OPEN shim into the current fail-CLOSED one, so the guards being down
    // becomes loud instead of silent — even though step 2 (setup.ts) cannot load at all.
    it('re-arms a stale shim WITHOUT loading the rule engine (works on a broken tree)', () => {
        const root = rootWithStaleShim();
        expect(fs.readFileSync(shimPath(root), 'utf8')).not.toBe(renderShim());  // stale/fail-open

        expect(findShimRoot(root)).toBe(root);   // installer can see there IS a shim to re-arm
        healShim(root);                          // pure fs+path — no @webpieces/rules-config anywhere

        expect(fs.readFileSync(shimPath(root), 'utf8')).toBe(renderShim());      // now fail-closed
        expect(fs.readFileSync(shimPath(root), 'utf8')).toContain(RECOVERY_CMD);
    });

    it('reports no shim to re-arm when none is committed (a global install)', () => {
        expect(findShimRoot(mktmp())).toBeNull();
    });
});

// The load-time invariant the whole fix rests on. If anyone ever hoists the `require('./setup')` to a
// static import — or pulls @webpieces/rules-config in directly for a "quick helper" — node resolves the
// rule engine at MODULE LOAD, and a corrupt node_modules kills the installer before healShim can run.
// The bug returns silently and looks identical: a raw MODULE_NOT_FOUND trace, guards left fail-open.
// Asserting on the source is deliberate: it is the only check that fails LOUDLY at the moment of the
// mistake, rather than years later on someone's broken tree.
describe('install-entry — load-time dependency invariant (do not break this)', () => {
    const source = fs.readFileSync(path.join(__dirname, 'install-entry.ts'), 'utf8');

    it('has NO static import of the rule engine (it would run before healShim and crash)', () => {
        expect(source).not.toMatch(/^\s*import[^;]*from\s*'@webpieces\/rules-config'/m);
        expect(source).not.toMatch(/^\s*import[^;]*from\s*'\.\/setup'/m);
    });

    it('loads ./setup LAZILY, inside the function, so step 1 always runs first', () => {
        // The require must sit inside runInstaller — after healShim — not at module scope.
        const body = source.slice(source.indexOf('export async function runInstaller'));
        expect(body).toContain("require('./setup')");
    });

    it('imports only the dependency-free ./shim module at load time', () => {
        const staticImports = [...source.matchAll(/^\s*import\s+.*?from\s+'([^']+)'/gm)].map(m => m[1]);
        expect(staticImports.sort()).toEqual(['../core/to-error', './shim']);
    });
});
