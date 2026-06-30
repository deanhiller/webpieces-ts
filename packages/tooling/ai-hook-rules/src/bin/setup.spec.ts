import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    migrate, applyHook, installTargets, readSettings, hasHook,
    RULES_HOOK, GUARDS_HOOK,
} from './setup';

function mktmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-setup-'));
}

// A temp HOME so the "global" install target never touches the real ~/.claude/settings.json.
function targetsIn(root: string): ReturnType<typeof installTargets> {
    return installTargets(root, mktmp());
}

describe('migrate', () => {
    it('moves guards from rules → hookGuards and a top-level pr-gate → commands', () => {
        const result = migrate({
            rules: {
                'no-any-unknown': { mode: 'NEW_AND_MODIFIED_CODE', ignoreModifiedUntilEpoch: 0 },
                'pr-creation-guard': { mode: 'ON', ignoreModifiedUntilEpoch: 0 },
            },
            'pr-gate': { mode: 'OFF', buildCommand: 'echo ci', gates: [] },
        });

        expect(result.config.rules['no-any-unknown']).toBeDefined();
        expect(result.config.rules['pr-creation-guard']).toBeUndefined();
        expect(result.config.hookGuards['pr-creation-guard']).toBeDefined();
        expect(result.config.commands['pr-gate']).toBeDefined();
        expect((result.config as { 'pr-gate'?: unknown })['pr-gate']).toBeUndefined();
        expect(result.config.commands['upsertPr']).toBe('pnpm wp-start-upsert-pr');
        expect(result.config.commands['mergeComplete']).toBe('pnpm wp-finish-upsert-pr');
    });

    it('adds every missing built-in into its correct section (OFF)', () => {
        const result = migrate({ rules: {}, hookGuards: {}, commands: { 'pr-gate': { mode: 'OFF' } } });
        // A code rule and a guard both get seeded into the right section.
        expect(result.config.rules['max-file-lines']).toEqual({ mode: 'OFF', ignoreModifiedUntilEpoch: 0 });
        expect(result.config.hookGuards['branch-creation-guard']).toEqual({ mode: 'OFF', ignoreModifiedUntilEpoch: 0 });
    });

    it('reports no changes for an already-migrated config', () => {
        const once = migrate({ rules: {}, hookGuards: {}, commands: {} }).config;
        const twice = migrate({ ...once });
        expect(twice.changes).toEqual([]);
    });
});

describe('applyHook', () => {
    it('installs the rules hook into project-for-you (settings.local.json) with the right matcher', () => {
        const root = mktmp();
        const targets = targetsIn(root);
        const projectForYou = targets[1];
        applyHook(RULES_HOOK, projectForYou, targets, root);

        const settings = readSettings(projectForYou.settingsPath);
        expect(hasHook(settings, 'wp-ai-rules-hook')).toBe(true);
        const entry = settings.hooks!.PreToolUse![0];
        expect(entry.matcher).toBe('Write|Edit|MultiEdit');
        expect(entry.hooks[0].command).toBe('./node_modules/.bin/wp-ai-rules-hook');
    });

    it('installs the guards hook globally with an absolute exact path (no bridge)', () => {
        const root = mktmp();
        const targets = targetsIn(root);
        const global = targets[2];
        applyHook(GUARDS_HOOK, global, targets, root);

        const settings = readSettings(global.settingsPath);
        const cmd = settings.hooks!.PreToolUse!.find(e => e.matcher === 'Write|Edit|MultiEdit|Bash')!.hooks[0].command;
        expect(cmd).toBe(`node ${path.join(root, 'node_modules', '.bin', 'wp-ai-guards-hook')}`);
        expect(cmd).not.toContain('global-hook.js');
    });

    it('moves a hook between locations and uninstalls cleanly', () => {
        const root = mktmp();
        const targets = targetsIn(root);
        // Install to project, then move to project-for-you.
        applyHook(RULES_HOOK, targets[0], targets, root);
        applyHook(RULES_HOOK, targets[1], targets, root);
        expect(hasHook(readSettings(targets[0].settingsPath), 'wp-ai-rules-hook')).toBe(false);
        expect(hasHook(readSettings(targets[1].settingsPath), 'wp-ai-rules-hook')).toBe(true);

        // Uninstall (choose none).
        applyHook(RULES_HOOK, null, targets, root);
        expect(hasHook(readSettings(targets[1].settingsPath), 'wp-ai-rules-hook')).toBe(false);
    });
});
