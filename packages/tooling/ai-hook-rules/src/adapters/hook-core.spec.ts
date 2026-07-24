import { describe, it, expect } from 'vitest';
import * as path from 'path';

import { shimStaleRecoveryDecision } from './hook-core';
import { INSTALL_HOOKS_CMD, UPGRADE_SHIM_CMD, RESTORE_SHIM_CMD } from '../bin/shim';
import { CONFIG_FILENAME } from '../core/load-config';

/**
 * shimStaleRecoveryDecision — what a STALE committed shim lets through. The carve-out is the whole
 * point: a stale shim must never trap the actions needed to recover. The original "block everything but
 * the cures" shape shadowed the always-allowed webpieces.config.json edit AND blocked reads, so a repo
 * that also needed its config fixed would deadlock (blocked from editing the one file whose edit is
 * always allowed, and from reading it to know how). These lock the recovery path open.
 */
describe('shimStaleRecoveryDecision — recovery is never trapped by a stale shim', () => {
    it('passes ANY Read through (you must read to know how to fix)', () => {
        // A read carries no command; even an unrelated path is let through.
        expect(shimStaleRecoveryDecision('Read', '', '/repo/src/anything.ts')).toBe('pass');
        expect(shimStaleRecoveryDecision('Read', '', '')).toBe('pass');
    });

    it('allows the three Bash cures directly (allow-cure), including the 2>&1 | tail spelling', () => {
        for (const cmd of [INSTALL_HOOKS_CMD, UPGRADE_SHIM_CMD, RESTORE_SHIM_CMD, `${INSTALL_HOOKS_CMD} 2>&1 | tail -20`]) {
            expect(shimStaleRecoveryDecision('Bash', cmd, ''), `cure: ${cmd}`).toBe('allow-cure');
        }
    });

    it('passes an edit to webpieces.config.json through (the always-allowed recovery target)', () => {
        for (const tool of ['Write', 'Edit', 'MultiEdit']) {
            expect(shimStaleRecoveryDecision(tool, '', `/repo/${CONFIG_FILENAME}`), `${tool} at root`).toBe('pass');
            // basename match, so a config in a subdir/nested clone is recognised too.
            expect(shimStaleRecoveryDecision(tool, '', path.join('/repo/packages/app', CONFIG_FILENAME)), `${tool} nested`).toBe('pass');
        }
    });

    it('denies all OTHER work: a chained cure, an unrelated command, and edits to other files', () => {
        const deny: Array<[string, string, string]> = [
            ['Bash', `${RESTORE_SHIM_CMD} && git status --short`, ''], // the audit-log && spelling
            ['Bash', 'git commit -m x', ''],
            ['Bash', 'pnpm build', ''],
            ['Write', '', '/repo/src/index.ts'],
            ['Edit', '', '/repo/README.md'],
            ['MultiEdit', '', '/repo/package.json'],                   // NOT webpieces.config.json
        ];
        for (const [tool, cmd, file] of deny) {
            expect(shimStaleRecoveryDecision(tool, cmd, file), `${tool} ${cmd} ${file}`).toBe('deny');
        }
    });
});
