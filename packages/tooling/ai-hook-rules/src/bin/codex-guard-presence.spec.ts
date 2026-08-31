import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { dotWebpieces } from '@webpieces/rules-config';

import { CodexGuardPresence, CodexSessionDetector } from './codex-guard-presence';
import { L0_SHIM_STREAM } from '../core/log-streams';

/**
 * GUARD-PRESENCE ATTESTATION — "did the guards actually RUN in this Codex session?"
 *
 * The failure it exists for cannot be seen at install time: Codex's untrusted-hook prompt offers
 * `Continue without trusting (hooks won't run)`, so a correctly installed, correctly trusted-on-disk
 * repo can still run a whole session with every tool call unguarded and no warning of any kind. The only
 * evidence that survives is the L0 shim log, which writes one row per tool call on EVERY path.
 */
let root = '';

beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-guard-presence-')));
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

/** Write `rows` L0 shim lines into the tree, as the shim itself would. */
function writeShimRows(rows: number): void {
    const dir = path.join(dotWebpieces.logs(root), L0_SHIM_STREAM);
    fs.mkdirSync(dir, { recursive: true });
    const line = 'ts\twp-ai-guards-hook\tBash\tai=codex\ttree=primary\tlayer=L0\trow=1\tshim=/x\tfault=-\tPASS-BIN-ALLOW\tls\n';
    fs.writeFileSync(path.join(dir, 'sess-coordinator-wp-ai-guards-hook.log'), line.repeat(rows));
}

const CODEX_ENV: NodeJS.ProcessEnv = { CODEX_MANAGED_BY_NPM: '1' };
const PLAIN_ENV: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };

describe('CodexSessionDetector — the fingerprints are MEASURED, including the one that does not exist', () => {
    const detector = new CodexSessionDetector();

    it.each([
        ['CODEX_MANAGED_BY_NPM', { CODEX_MANAGED_BY_NPM: '1' }],
        ['CODEX_MANAGED_PACKAGE_ROOT', { CODEX_MANAGED_PACKAGE_ROOT: '/opt/codex' }],
        ['the arg0 PATH entry', { PATH: `/usr/bin:${CodexSessionDetector.PATH_MARKER}:/bin` }],
    ] as ReadonlyArray<readonly [string, NodeJS.ProcessEnv]>)(
        'recognises a Codex session from %s ALONE', (_name: string, env: NodeJS.ProcessEnv) => {
            expect(detector.isCodexSession(env)).toBe(true);
        });

    /**
     * ANY ONE is enough, deliberately. They come from different install shapes, and requiring all three
     * would answer "not Codex" for a real Codex session — which, for a check that BLOCKS on the absence
     * of evidence, silently converts an unguarded session into an unchecked one.
     */
    it('does not require all three', () => {
        expect(detector.isCodexSession({ CODEX_MANAGED_BY_NPM: '1' })).toBe(true);
    });

    it('says no for a plain environment, and for an EMPTY fingerprint value', () => {
        expect(detector.isCodexSession(PLAIN_ENV)).toBe(false);
        expect(detector.isCodexSession({ CODEX_MANAGED_BY_NPM: '' })).toBe(false);
        expect(detector.isCodexSession({})).toBe(false);
    });

    /**
     * There is NO `CODEX_SESSION_ID` (measured: 46 vars). Reaching for one is the obvious move and it
     * would silently never fire, so the absence is pinned rather than left to a comment.
     */
    it('does not depend on CODEX_SESSION_ID, which does not exist', () => {
        expect(CodexSessionDetector.ENV_KEYS).not.toContain('CODEX_SESSION_ID');
        expect(detector.isCodexSession({ CODEX_SESSION_ID: 'abc' })).toBe(false);
    });
});

describe('CodexGuardPresence', () => {
    const presence = new CodexGuardPresence();

    it('BLOCKS a Codex session that produced zero L0 shim rows', () => {
        const verdict = presence.check(root, CODEX_ENV);
        expect(verdict.ok).toBe(false);
        expect(verdict.rows).toBe(0);
        expect(verdict.reason).toContain('NOT ONE guard has run');
    });

    /**
     * The refusal names BOTH causes, because they have different cures and an agent handed only one will
     * run it, see nothing change, and conclude the check is broken.
     */
    it('names the untrusted-prompt cause AND the wrong-matcher cause, each with its own cure', () => {
        const reason = presence.check(root, CODEX_ENV).reason;
        expect(reason).toContain('Continue without trusting');
        expect(reason).toContain('Trust all');
        expect(reason).toContain('wp-install-ai-hooks --target=project');
    });

    it('ALLOWS a Codex session once the shim has written even one row', () => {
        writeShimRows(1);
        const verdict = presence.check(root, CODEX_ENV);
        expect(verdict.ok).toBe(true);
        expect(verdict.rows).toBe(1);
    });

    it('counts every row across every writer file in the stream', () => {
        writeShimRows(7);
        expect(presence.check(root, CODEX_ENV).rows).toBe(7);
    });

    /**
     * OUTSIDE a Codex session it is a no-op that says so — which is what makes it safe to call
     * unconditionally from a shared build path rather than guarded by a caller that might forget.
     */
    it('is a no-op outside a Codex session, even with no logs at all', () => {
        const verdict = presence.check(root, PLAIN_ENV);
        expect(verdict.ok).toBe(true);
        expect(verdict.reason).toContain('not a Codex session');
    });

    it('never throws when the tree cannot be read, and refuses rather than waving through', () => {
        const gone = path.join(root, 'does', 'not', 'exist');
        expect(presence.check(gone, CODEX_ENV).ok).toBe(false);
        expect(presence.check(gone, PLAIN_ENV).ok).toBe(true);
    });
});
