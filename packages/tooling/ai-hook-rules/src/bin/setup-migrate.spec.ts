import { migrate } from './setup';
import { allRuleNames, recommendedSeedMode, validateWebpiecesConfig, validateSectionPlacement } from '@webpieces/rules-config';

/**
 * `wp-install-ai-hooks`' config MIGRATOR — split out of setup.spec.ts, which had grown past the
 * max-file-lines limit while covering two unrelated things: this (rewriting webpieces.config.json into
 * the current shape) and the shim/hook-registration surface. They share no fixtures, so the split is
 * along the seam that was already there.
 *
 * The migrator is the one command that can repair a config the loader now hard-rejects, which is what
 * makes each case below load-bearing: a retirement it applies WRONGLY is not a cosmetic bug, it is a
 * cure that manufactures a fresh validation failure.
 */

describe('migrate', () => {
    it('moves guards from rules → hookGuards and a top-level pr-gate → commands', () => {
        const result = migrate({
            rules: {
                'no-any-unknown': { mode: 'NEW_AND_MODIFIED_CODE', turnOffRuleUntilEpoch: 0 },
                'pr-creation-or-push-guard': { mode: 'ON', turnOffRuleUntilEpoch: 0 },
            },
            'pr-gate': { mode: 'OFF', buildCommand: 'echo ci', gates: [] },
        });

        expect(result.config.rules['no-any-unknown']).toBeDefined();
        expect(result.config.rules['pr-creation-or-push-guard']).toBeUndefined();
        expect(result.config.hookGuards['pr-creation-or-push-guard']).toBeDefined();
        expect(result.config.commands['pr-gate']).toBeDefined();
        expect((result.config as { 'pr-gate'?: unknown })['pr-gate']).toBeUndefined();
        const hints = result.config.commands['guardHints'] as Record<string, unknown>;
        expect(hints['prCreationOrPush']).toBe('pnpm wp-start-upsert-pr');
        expect(hints['mergeInProgress']).toBe('pnpm wp-finish-upsert-pr');
    });

    // migrate() has to actually move what the validator's errors say is retired. It used to SEED the
    // flat keys and know nothing of the guard renames, so the installer reported success and the config
    // still failed to load.
    it('moves the retired flat command strings into guardHints and deletes them', () => {
        const result = migrate({
            rules: {}, hookGuards: {},
            commands: { 'pr-gate': { mode: 'OFF' }, upsertPr: 'pnpm my-upsert', mergeComplete: 'pnpm my-finish' },
        });
        expect(result.config.commands['upsertPr']).toBeUndefined();
        expect(result.config.commands['mergeComplete']).toBeUndefined();
        const hints = result.config.commands['guardHints'] as Record<string, unknown>;
        // The consumer's own value wins over the default — a renamed gated command survives the migration.
        expect(hints['prCreationOrPush']).toBe('pnpm my-upsert');
        expect(hints['mergeInProgress']).toBe('pnpm my-finish');
        expect(result.changes.some(c => c.includes('moved retired commands.upsertPr'))).toBe(true);
    });

    it('renames retired guard keys instead of leaving them to fail validation', () => {
        const result = migrate({
            rules: {},
            hookGuards: { 'main-stale-guard': { mode: 'ON', turnOffRuleUntilEpoch: 0 } },
            commands: { 'pr-gate': { mode: 'OFF' } },
        });
        expect(result.config.hookGuards['main-stale-guard']).toBeUndefined();
        expect(result.config.hookGuards['read-stale-guard']).toEqual({ mode: 'ON', turnOffRuleUntilEpoch: 0 });
        expect(result.changes.some(c => c.includes('renamed retired "main-stale-guard"'))).toBe(true);
    });

    it('drops a retired name rather than clobbering an explicit entry under the new name', () => {
        const result = migrate({
            rules: {},
            hookGuards: {
                'main-stale-guard': { mode: 'OFF', turnOffRuleUntilEpoch: 0 },
                'read-stale-guard': { mode: 'ON', turnOffRuleUntilEpoch: 0 },
            },
            commands: { 'pr-gate': { mode: 'OFF' } },
        });
        expect(result.config.hookGuards['main-stale-guard']).toBeUndefined();
        expect(result.config.hookGuards['read-stale-guard']).toEqual({ mode: 'ON', turnOffRuleUntilEpoch: 0 });
    });

    /**
     * NOT EVERY RETIREMENT IS A RENAME, and the migrator used to assume it was.
     *
     * `whole-repo-build-guard` moved OUT of webpieces.config.json entirely, so its `movedTo` is the PROSE
     * destination `~/.webpieces/config.json → experimental.whole-repo-build-guard` rather than a sibling
     * key. The old `section[entry.movedTo] = section[entry.key]` therefore created a hookGuards entry
     * literally NAMED that whole sentence — a key no validator knows, reported as another unknown rule on
     * the very next run. A cure that manufactures a fresh instance of the fault it is curing.
     *
     * `prunable` is the discriminator: deletion-only retirements are deleted, exactly as ConfigPruner
     * does with them.
     */
    it('DELETES a retirement that left this file, instead of renaming it to its own prose destination', () => {
        const result = migrate({
            rules: {},
            hookGuards: { 'whole-repo-build-guard': { mode: 'ON', turnOffRuleUntilEpoch: 0 } },
            commands: { 'pr-gate': { mode: 'OFF' } },
        });
        expect(result.config.hookGuards['whole-repo-build-guard']).toBeUndefined();
        // Nothing anywhere is named after the destination prose.
        for (const key of Object.keys(result.config.hookGuards)) {
            expect(key).not.toContain('~/.webpieces/config.json');
            expect(key).not.toContain('→');
        }
        expect(result.changes.some(c => c.includes('deleted retired "whole-repo-build-guard"'))).toBe(true);
    });

    it('adds every missing built-in into its correct section, ENFORCING at its recommended mode', () => {
        const result = migrate({ rules: {}, hookGuards: {}, commands: { 'pr-gate': { mode: 'OFF' } } });
        // A code rule and a guard both get seeded into the right section, with BOTH escape hatches shown.
        // The mode is rules-config's recommendedSeedMode() — NOT 'OFF'. Seeding OFF is what left adopters
        // with a fully installed webpieces that enforced nothing.
        expect(result.config.rules['max-file-lines']).toMatchObject(
            { mode: recommendedSeedMode('max-file-lines'), turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null });
        // toMatchObject, not toEqual: a seeded entry also carries every OTHER schema-required field —
        // here autoReapMergedBranches, which ships TRUE so dead branches are reaped without anyone
        // having to opt in. Every reap is logged with a `recover=` command, so it is one paste to undo.
        expect(result.config.hookGuards['branch-creation-guard']).toMatchObject(
            { mode: recommendedSeedMode('branch-creation-guard'), turnOffRuleUntilEpoch: 0,
              turnOffRuleWhileOnBranch: null, autoReapMergedBranches: true });
        expect(result.config.rules['max-file-lines']['mode']).not.toEqual('OFF');
        expect(result.config.hookGuards['branch-creation-guard']['mode']).not.toEqual('OFF');
    });

    it('seeds NO built-in as OFF — every rule arrives enforcing (gradual where the rule supports it)', () => {
        const result = migrate({ rules: {}, hookGuards: {}, commands: { 'pr-gate': { mode: 'OFF' } } });
        const seeded = { ...result.config.rules, ...result.config.hookGuards };
        for (const name of allRuleNames()) {
            expect(seeded[name]['mode'], `${name} seeded OFF`).not.toEqual('OFF');
        }
    });

    // THE structural guard: whatever the installer writes must be a config the LOADER accepts. Both
    // sides read the same schema (seedEntryForRule -> RULE_SCHEMAS <- validateWebpiecesConfig), and
    // this assertion is what keeps them wired together — it makes "the installer cannot emit a config
    // the loader rejects" a build-time fact instead of something a consumer rediscovers on first run.
    //
    // It caught a PRE-EXISTING gap: seeding emitted only mode + the two hatches, so every fresh
    // install wrote `"branch-creation-guard": {...}` with no `autoReapMergedBranches` and the config
    // failed validation immediately. That was equally broken back when seeding was OFF — the
    // missing-required-field check does not care what mode says.
    it('seeds/migrates a config that validates with ZERO errors', () => {
        const result = migrate({ rules: {}, hookGuards: {}, commands: { 'pr-gate': { mode: 'OFF' } } });
        const merged = { ...result.config.rules, ...result.config.hookGuards };
        expect(validateWebpiecesConfig(merged, false)).toEqual([]);
        // ...and every rule landed in the section the loader expects it in.
        expect(validateSectionPlacement(result.config.rules, result.config.hookGuards)).toEqual([]);
    });

    it('reports no changes for an already-migrated config', () => {
        const once = migrate({ rules: {}, hookGuards: {}, commands: {} }).config;
        const twice = migrate({ ...once });
        expect(twice.changes).toEqual([]);
    });
});
