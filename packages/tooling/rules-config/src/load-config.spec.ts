import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CONFIG_FILENAME } from './config-file';
import { loadAndValidate } from './load-config';
import { RETIRED_CONFIG_KEYS, RETIRED_SCOPE_RULE, RetiredConfigKey } from './retired-config-keys';
import { toError } from './to-error';
import { defaultRules } from './default-rules';
import { RULE_SCHEMAS } from './rule-schemas';
import { HOOK_GUARD_NAMES as SHIPPED_HOOK_GUARD_NAMES } from './sections';

function mktmp(contents: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-config-'));
    for (const [name, body] of Object.entries(contents)) {
        fs.writeFileSync(path.join(dir, name), body);
    }
    return dir;
}

// Minimal valid config — every built-in present in its correct section, all OFF with an explicit
// turnOffRuleUntilEpoch (0 = active; the hatch is optional now but kept here for realism), plus a
// valid commands.pr-gate block. Code rules go under `rules`; the bash guards go under `hookGuards`.
const HOOK_GUARD_NAMES = [
    'branch-creation-guard', 'pr-creation-or-push-guard', 'merge-in-progress-guard', 'pr-merge-guard',
    'redirect-how-to-merge-main', 'feature-branch-guard', 'read-stale-guard', 'merged-branch-bash-guard',
    // NOT 'whole-repo-build-guard' — it is retired as a repo-config key (it is switched from
    // ~/.webpieces/config.json instead), so naming it here would FAIL the load rather than configure it.
    'stale-main-bash-guard',
];
const CODE_RULE_NAMES = [
    'max-method-lines', 'max-file-lines', 'require-return-type', 'no-inline-type-literals',
    'no-any-unknown', 'no-implicit-any', 'prisma-validate-dtos', 'prisma-converter',
    'no-destructure', 'no-unmanaged-exceptions', 'catch-error-pattern', 'throw-cause-required',
    'angular-no-direct-api-in-resolver', 'no-symbol-di-tokens', 'no-client-creation-outside-server-or-client',
    'no-custom-css', 'no-process-exit-outside-main',
    'no-function-outside-class', 'inject-annotation-not-needed-for-concrete-class', 'framework-tag',
    'role-tag', 'no-file-import-cycles',
    'runtime-architecture', 'nx-wiring', 'di-graph', 'missing-design-annotation', 'no-js-files',
    'validate-ts-in-src', 'validate-architecture-unchanged', 'validate-no-architecture-cycles',
    'validate-packagejson', 'validate-versions-locked', 'validate-eslint-sync',
];

// Required fields beyond `mode` (the escape-hatch fields are all optional). Kept as data so adding
// another required field is a one-line fixture change rather than a hunt through every test.
const EXTRA_REQUIRED: Record<string, Record<string, unknown>> = {
    // Schema-required so unattended branch deletion is never a silent default — see rule-configs.ts.
    'branch-creation-guard': { autoReapMergedBranches: false },
};

function offEntries(names: string[], overrides: Record<string, unknown>): Record<string, unknown> {
    const base: Record<string, unknown> = {};
    for (const name of names) base[name] = { mode: 'OFF', turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null, ...EXTRA_REQUIRED[name] };
    return { ...base, ...overrides };
}

function allRulesOff(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    // Route each override to whichever section owns that name.
    const ruleOverrides: Record<string, unknown> = {};
    const guardOverrides: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(overrides)) {
        if (HOOK_GUARD_NAMES.includes(k)) guardOverrides[k] = v; else ruleOverrides[k] = v;
    }
    return {
        rules: offEntries(CODE_RULE_NAMES, ruleOverrides),
        hookGuards: offEntries(HOOK_GUARD_NAMES, guardOverrides),
        // match-rules is a required top-level section; [] is the allowed opt-out for these fixtures.
        'match-rules': [],
    };
}

function validPrGate(): Record<string, unknown> {
    return { mode: 'ON', buildCommand: 'echo ci', mergeMode: 'AUTO' };
}

// `sections` is { rules, hookGuards } from allRulesOff(); commands.pr-gate + the required
// excludePaths block are added here so the fixture always validates.
// The canonical shape: ONE flat glob list. The retired { rules, guards } object is rejected outright.
function validExcludePaths(): string[] {
    return [];
}
function writeConfig(sections: Record<string, unknown>, prGate: unknown = validPrGate()): string {
    return mktmp({ [CONFIG_FILENAME]: JSON.stringify({
        ...sections,
        commands: { 'pr-gate': prGate },
        excludePaths: validExcludePaths(),
    }) });
}

// A genuine syntax error survives every retry, so the hard failure is unchanged — but the message now
// names the retry count, so a race against another process's write is distinguishable from a real
// typo. The retry itself is unit-tested in config-file.spec.ts.
describe('loadAndValidate — malformed JSON', () => {
    it('throws InformAiError after the bounded retry, and says how many times it retried', () => {
        const dir = mktmp({ [CONFIG_FILENAME]: '{ this is not json' });
        expect(() => loadAndValidate(dir)).toThrow('webpieces.config.json could not be parsed as JSON');
        expect(() => loadAndValidate(dir)).toThrow('retried 3 times');
    });
});

describe('loadAndValidate', () => {
    it('returns lenient empties when no file is found', () => {
        const dir = mktmp({});
        const cwd = fs.mkdtempSync(path.join(dir, 'inner-'));
        const loaded = loadAndValidate(cwd);
        // May walk up to a real config; only assert the shape of the three views.
        expect(loaded.resolved.rules).toBeInstanceOf(Map);
        expect(loaded.rulesConfig).toBeDefined();
        expect(loaded.prGate).toBeDefined();
    });

    it('merges defaults with overrides and honors mode:OFF; exposes all three views', () => {
        const dir = writeConfig(allRulesOff({
            'max-file-lines': { limit: 500, mode: 'NEW_AND_MODIFIED_FILES', turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null },
            'no-any-unknown': { mode: 'OFF', turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null },
        }));
        const loaded = loadAndValidate(dir);

        expect(loaded.configPath).toBe(path.join(dir, CONFIG_FILENAME));
        expect(loaded.prGate.buildCommand).toBe('echo ci');

        const maxFileLines = loaded.resolved.rules.get('max-file-lines');
        expect(maxFileLines!.isOff).toBe(false);
        expect(maxFileLines!.options['limit']).toBe(500);

        const noAnyUnknown = loaded.resolved.rules.get('no-any-unknown');
        expect(noAnyUnknown!.isOff).toBe(true);
    });

    it('preserves unknown option keys for consumers that understand them', () => {
        const dir = writeConfig(allRulesOff({
            'no-destructure': { mode: 'NEW_AND_MODIFIED_CODE', disableAllowed: false, turnOffRuleUntilEpoch: 12345, turnOffRuleWhileOnBranch: null },
        }));
        const rule = loadAndValidate(dir).resolved.rules.get('no-destructure')!;
        expect(rule.options['disableAllowed']).toBe(false);
        expect(rule.options['turnOffRuleUntilEpoch']).toBe(12345);
    });

    it('throws listing missing rules when config has none', () => {
        const dir = mktmp({ [CONFIG_FILENAME]: JSON.stringify({ rules: {}, commands: { 'pr-gate': validPrGate() } }) });
        expect(() => loadAndValidate(dir)).toThrow('Not configured in webpieces.config.json');
    });

    it('throws when the commands.pr-gate block is missing entirely', () => {
        const dir = mktmp({ [CONFIG_FILENAME]: JSON.stringify(allRulesOff()) });
        expect(() => loadAndValidate(dir)).toThrow('[pr-gate] Not configured');
    });

    it('throws when the required excludePaths block is missing', () => {
        const dir = mktmp({ [CONFIG_FILENAME]: JSON.stringify({ ...allRulesOff(), commands: { 'pr-gate': validPrGate() } }) });
        expect(() => loadAndValidate(dir)).toThrow('[excludePaths] Not configured');
    });

    it('parses excludePaths into the typed ExcludePaths view', () => {
        const dir = mktmp({ [CONFIG_FILENAME]: JSON.stringify({
            ...allRulesOff(),
            commands: { 'pr-gate': validPrGate() },
            excludePaths: ['repositories/**', 'vendor/**'],
        }) });
        expect(loadAndValidate(dir).excludePaths.paths).toEqual(['repositories/**', 'vendor/**']);
    });

    // The retired two-list object fails the LOAD, it is not unioned. Tolerating it is what kept consumer
    // configs (this repo's included) on the dead shape release after release.
    it('throws on the retired { rules, guards } object, naming the union it must become', () => {
        const dir = mktmp({ [CONFIG_FILENAME]: JSON.stringify({
            ...allRulesOff(),
            commands: { 'pr-gate': validPrGate() },
            excludePaths: { rules: ['repositories/**'], guards: ['vendor/**'] },
        }) });
        expect(() => loadAndValidate(dir)).toThrow('RETIRED');
        expect(() => loadAndValidate(dir)).toThrow('ONE array holding the union');
    });
});

describe('loadAndValidate — escape-hatch fields', () => {
    it('surfaces turnOffRuleUntilEpoch + turnOffRuleWhileOnBranch on the resolved rule (read directly)', () => {
        const dir = writeConfig(allRulesOff({
            'no-destructure': { mode: 'NEW_AND_MODIFIED_CODE', turnOffRuleUntilEpoch: 1771931925, turnOffRuleWhileOnBranch: 'deanhiller/foo' },
        }));
        const rule = loadAndValidate(dir).resolved.rules.get('no-destructure')!;
        // RuleGate + AbstractRule.shouldRun read these names directly — no aliasing/normalization anymore.
        expect(rule.options['turnOffRuleUntilEpoch']).toBe(1771931925);
        expect(rule.options['turnOffRuleWhileOnBranch']).toBe('deanhiller/foo');
    });

    it('preserves a null branch hatch (the always-on / no-branch value)', () => {
        const dir = writeConfig(allRulesOff({
            'no-destructure': { mode: 'NEW_AND_MODIFIED_CODE', turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null },
        }));
        const rule = loadAndValidate(dir).resolved.rules.get('no-destructure')!;
        expect(rule.options['turnOffRuleWhileOnBranch']).toBeNull();
    });
});

describe('loadAndValidate — sections & commands', () => {
    it('errors when a guard is left in the rules section (placement)', () => {
        const sections = allRulesOff();
        // Misplace a guard into rules.
        (sections['rules'] as Record<string, unknown>)['pr-creation-or-push-guard'] = { mode: 'ON', turnOffRuleUntilEpoch: 0 };
        const dir = mktmp({ [CONFIG_FILENAME]: JSON.stringify({ ...sections, commands: { 'pr-gate': validPrGate() } }) });
        expect(() => loadAndValidate(dir)).toThrow('belongs in the "hookGuards" section');
    });

    it('errors on a retired top-level pr-gate block', () => {
        const dir = mktmp({ [CONFIG_FILENAME]: JSON.stringify({ ...allRulesOff(), 'pr-gate': validPrGate() }) });
        expect(() => loadAndValidate(dir)).toThrow('top-level "pr-gate" block is RETIRED');
    });

    it('throws on the retired flat commands.upsertPr instead of injecting it into the guard', () => {
        const sections = allRulesOff();
        const dir = mktmp({ [CONFIG_FILENAME]: JSON.stringify({
            ...sections,
            commands: { 'pr-gate': validPrGate(), upsertPr: 'pnpm my-upsert' },
            excludePaths: validExcludePaths(),
        }) });
        expect(() => loadAndValidate(dir)).toThrow('"upsertPr" is a RETIRED');
        expect(() => loadAndValidate(dir)).toThrow('commands.guardHints.prCreationOrPush');
    });

    it('sources both guard hints from commands.guardHints (canonical) into their guards', () => {
        const sections = allRulesOff();
        const dir = mktmp({ [CONFIG_FILENAME]: JSON.stringify({
            ...sections,
            commands: {
                'pr-gate': validPrGate(),
                guardHints: { prCreationOrPush: 'pnpm gh-upsert', mergeInProgress: 'pnpm gh-finish' },
            },
            excludePaths: validExcludePaths(),
        }) });
        const loaded = loadAndValidate(dir);
        expect(loaded.commands.upsertPr).toBe('pnpm gh-upsert');
        expect(loaded.commands.mergeComplete).toBe('pnpm gh-finish');
        const prGuard = loaded.rulesConfig['pr-creation-or-push-guard'] as Record<string, unknown>;
        expect(prGuard['upsertPrCommand']).toBe('pnpm gh-upsert');
        const mergeGuard = loaded.rulesConfig['merge-in-progress-guard'] as Record<string, unknown>;
        expect(mergeGuard['mergeCompleteCommand']).toBe('pnpm gh-finish');
    });

    // There is no precedence chain to test any more: a half-migrated file does not quietly resolve to the
    // canonical value, it fails until the retired key is gone. That is the point — a file that keeps
    // working with both keys present is a file nobody ever finishes migrating.
    it('still throws when guardHints is present but the retired flat key was left behind', () => {
        const sections = allRulesOff();
        const dir = mktmp({ [CONFIG_FILENAME]: JSON.stringify({
            ...sections,
            commands: { 'pr-gate': validPrGate(), guardHints: { prCreationOrPush: 'pnpm canonical' }, upsertPr: 'pnpm legacy' },
            excludePaths: validExcludePaths(),
        }) });
        expect(() => loadAndValidate(dir)).toThrow('"upsertPr" is a RETIRED');
    });

    it('falls back to the built-in default when guardHints omits a name', () => {
        const sections = allRulesOff();
        const dir = mktmp({ [CONFIG_FILENAME]: JSON.stringify({
            ...sections,
            commands: { 'pr-gate': validPrGate(), guardHints: { prCreationOrPush: 'pnpm canonical' } },
            excludePaths: validExcludePaths(),
        }) });
        const loaded = loadAndValidate(dir);
        expect(loaded.commands.upsertPr).toBe('pnpm canonical');
        expect(loaded.commands.mergeComplete).toBe('pnpm wp-finish-upsert-pr');
    });
});

// Regression for the config-validation banner (bugReport.md, released 0.3.241): a stale/unknown rule
// key made the guard fail closed on every Bash/Write/Edit EXCEPT edits to webpieces.config.json, but
// the surfaced banner never said so — so an AI read "everything is blocked" and escalated to the human
// instead of editing the config to unblock itself. The banner must tell the reader that editing
// webpieces.config.json is ALWAYS allowed through the guard, and that editing it is the whole fix.
//
// It used to ALSO lead with `pnpm install`, and this spec asserted that ordering. That assertion is
// REPLACED, not preserved: the guard bin runs only when package.json and node_modules already agree
// (ai-hook.sh gates on `[ -z "$DRIFT_PKG" ]`), so an install provably changes nothing here and naming
// it as step 1 is the detour that started this rewrite. What survives is the reason the ordering
// existed — do not gut valid config by deleting an unknown key — now aimed at the PIN.
describe('loadAndValidate — config-error banner (unblock instructions)', () => {
    function bannerFor(unknownRuleKey: string): string {
        const sections = allRulesOff();
        (sections['rules'] as Record<string, unknown>)[unknownRuleKey] = { mode: 'OFF', turnOffRuleUntilEpoch: 0 };
        const dir = writeConfig(sections);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            loadAndValidate(dir);
        } catch (err: unknown) {
            const error = toError(err);
            return error.message;
        }
        throw new Error('expected loadAndValidate to throw on an unknown rule key');
    }

    it('tells the reader that editing webpieces.config.json is ALWAYS allowed (so an AI never deadlocks)', () => {
        const msg = bannerFor('totally-made-up-rule');
        expect(msg).toContain('ALWAYS allowed');
        expect(msg).toContain('webpieces.config.json');
    });

    it('names editing the config as THE fix, and rules `pnpm install` out instead of prescribing it', () => {
        const msg = bannerFor('totally-made-up-rule');
        expect(msg).toContain('THE FIX: edit webpieces.config.json');
        expect(msg).toContain('Do NOT run `pnpm install`');
        expect(msg).not.toContain('FIX ORDER');
    });

    /**
     * END TO END, through the real loader: the advice a reader gets for an unknown key is DELETE IT, and
     * the stale @webpieces PIN survives only as the secondary note. This assertion used to demand the
     * opposite ("Do NOT delete a key just because it is reported unknown") — see config-pruner.spec.ts
     * for why that inversion cost a consumer most of a day.
     */
    it('tells the reader to DELETE an unknown key, keeping the @webpieces PIN as the secondary note', () => {
        const msg = bannerFor('totally-made-up-rule');
        expect(msg).toContain('DO delete any key reported as an unknown rule');
        expect(msg).not.toContain('Do NOT delete a key just because it is reported unknown');
        expect(msg).toContain('package.json pins an @webpieces OLDER');
    });

    // The self-contradiction the report opened on: one output, two opposite orders about `pnpm install`.
    it('never says both "run `pnpm install`" and "do NOT run `pnpm install`" in one output', () => {
        const msg = bannerFor('totally-made-up-rule');
        expect(msg.split('pnpm install')).toHaveLength(2);
        expect(msg).toContain('Do NOT run `pnpm install`');
    });
});

/**
 * Renamed guards used to be rewritten SILENTLY before validation, so the old name kept working forever and
 * no consumer was ever told to change it — which is why the alias table could never be deleted. Each rename
 * is now a hard error naming the new key. The rename itself is a one-line config edit.
 */
describe('loadAndValidate — retired guard names', () => {
    const RENAMES: readonly (readonly [string, string])[] = [
        ['pr-merge-cleanup', 'pr-merge-guard'],
        ['pr-creation-guard', 'pr-creation-or-push-guard'],
        ['main-stale-guard', 'read-stale-guard'],
    ];

    for (const rename of RENAMES) {
        const oldName = rename[0];
        const newName = rename[1];
        it(`throws on the retired ${oldName} key and names ${newName}`, () => {
            const sections = allRulesOff();
            // Simulate a webpieces.config.json that still uses the OLD guard name.
            const guards = sections['hookGuards'] as Record<string, unknown>;
            guards[oldName] = guards[newName];
            delete guards[newName];
            const dir = writeConfig(sections);
            expect(() => loadAndValidate(dir)).toThrow(`"${oldName}" is a RETIRED`);
            expect(() => loadAndValidate(dir)).toThrow(newName);
        });
    }

    // The generic unknown-rule message can only say "delete it". For a RENAME that is destructive advice —
    // the value has to carry over to the new key — so a name the retirement table knows must take the
    // table's path and get the migration instruction instead.
    it('does not send a retired name down the "your validator is stale" path', () => {
        const sections = allRulesOff();
        const guards = sections['hookGuards'] as Record<string, unknown>;
        guards['main-stale-guard'] = guards['read-stale-guard'];
        delete guards['read-stale-guard'];
        const dir = writeConfig(sections);
        expect(() => loadAndValidate(dir)).not.toThrow('[main-stale-guard] Unknown rule');
    });
});

/**
 * THE POLICY GUARD, end to end. Every entry in RETIRED_CONFIG_KEYS must actually FAIL the load with its
 * destination named — that is the whole contract that lets webpieces ship config changes with no
 * backwards-compatible release: the agent is handed the edit and applies it.
 *
 * This loop is what makes the policy structural instead of aspirational. Re-add a `??` fallback that
 * quietly accepts a retired key — the exact thing that kept `commands.upsertPr` and the two-list
 * `excludePaths` alive in this repo's own config for releases — and the matching case goes red.
 */
describe('loadAndValidate — every retired key fails the load', () => {
    // Build the minimal config that still carries `entry`, so the ONLY reason to throw is the retirement.
    function configCarrying(entry: RetiredConfigKey): string {
        const sections = allRulesOff();
        if (entry.scope === RETIRED_SCOPE_RULE) {
            const guards = sections['hookGuards'] as Record<string, unknown>;
            guards[entry.key] = { mode: 'OFF', turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null };
            return writeConfig(sections);
        }
        if (entry.label === '[excludePaths]') {
            return mktmp({ [CONFIG_FILENAME]: JSON.stringify({
                ...sections,
                commands: { 'pr-gate': validPrGate() },
                excludePaths: { rules: [], guards: [] },
            }) });
        }
        return mktmp({ [CONFIG_FILENAME]: JSON.stringify({
            ...sections,
            commands: { 'pr-gate': validPrGate(), [entry.key]: 'pnpm something' },
            excludePaths: validExcludePaths(),
        }) });
    }

    /**
     * The guard is EXPERIMENTAL and switched ONLY from ~/.webpieces/config.json. Shipping it in
     * `defaultRules` is what made it a rule every consumer had to configure: with a default entry it is
     * loaded, the config-sync check (fault Y) finds no matching key, and EVERY Bash call is blocked on
     * upgrade. That happened. This assertion is the tripwire.
     */
    it('does not ship whole-repo-build-guard as a default rule — fault Y must be unreachable for it', () => {
        expect(Object.keys(defaultRules)).not.toContain('whole-repo-build-guard');
        expect(RULE_SCHEMAS['whole-repo-build-guard']).toBeUndefined();
        expect(SHIPPED_HOOK_GUARD_NAMES).not.toContain('whole-repo-build-guard');
    });

    for (const entry of RETIRED_CONFIG_KEYS) {
        it(`rejects ${entry.label} "${entry.key}" and names where it went`, () => {
            const dir = configCarrying(entry);
            expect(() => loadAndValidate(dir)).toThrow(`"${entry.key}" is a RETIRED`);
            if (entry.movedTo !== '') expect(() => loadAndValidate(dir)).toThrow(entry.movedTo);
        });
    }
});
