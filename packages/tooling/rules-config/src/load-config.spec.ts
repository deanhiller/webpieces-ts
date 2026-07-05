import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CONFIG_FILENAME } from './config-file';
import { loadAndValidate } from './load-config';

function mktmp(contents: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-config-'));
    for (const [name, body] of Object.entries(contents)) {
        fs.writeFileSync(path.join(dir, name), body);
    }
    return dir;
}

// Minimal valid config — every built-in present in its correct section, all OFF with the
// now-required ignoreModifiedUntilEpoch (0 = active), plus a valid commands.pr-gate block.
// Code rules go under `rules`; the 6 bash guards go under `hookGuards`.
const HOOK_GUARD_NAMES = [
    'branch-creation-guard', 'pr-creation-guard', 'merge-in-progress-guard', 'pr-merge-guard',
    'redirect-how-to-merge-main', 'feature-branch-guard',
];
const CODE_RULE_NAMES = [
    'max-method-lines', 'max-file-lines', 'require-return-type', 'no-inline-type-literals',
    'no-any-unknown', 'no-implicit-any', 'prisma-validate-dtos', 'prisma-converter',
    'no-destructure', 'no-unmanaged-exceptions', 'catch-error-pattern', 'throw-cause-required',
    'angular-no-direct-api-in-resolver', 'no-symbol-di-tokens', 'enforce-controller-naming', 'framework-tag',
    'role-tag', 'no-file-import-cycles',
    'runtime-architecture', 'nx-wiring', 'di-graph', 'no-js-files', 'validate-ts-in-src',
];

function offEntries(names: string[], overrides: Record<string, unknown>): Record<string, unknown> {
    const base: Record<string, unknown> = {};
    for (const name of names) base[name] = { mode: 'OFF', ignoreModifiedUntilEpoch: 0 };
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
    return { mode: 'ON', buildCommand: 'echo ci' };
}

// `sections` is { rules, hookGuards } from allRulesOff(); commands.pr-gate + the required
// excludePaths block are added here so the fixture always validates.
function validExcludePaths(): Record<string, unknown> {
    return { rules: [], guards: [] };
}
function writeConfig(sections: Record<string, unknown>, prGate: unknown = validPrGate()): string {
    return mktmp({ [CONFIG_FILENAME]: JSON.stringify({
        ...sections,
        commands: { 'pr-gate': prGate },
        excludePaths: validExcludePaths(),
    }) });
}

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
            'max-file-lines': { limit: 500, mode: 'NEW_AND_MODIFIED_FILES', ignoreModifiedUntilEpoch: 0 },
            'no-any-unknown': { mode: 'OFF', ignoreModifiedUntilEpoch: 0 },
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
            'no-destructure': { mode: 'NEW_AND_MODIFIED_CODE', disableAllowed: false, ignoreModifiedUntilEpoch: 12345 },
        }));
        const rule = loadAndValidate(dir).resolved.rules.get('no-destructure')!;
        expect(rule.options['disableAllowed']).toBe(false);
        expect(rule.options['ignoreModifiedUntilEpoch']).toBe(12345);
    });

    it('throws InformAiError on malformed JSON', () => {
        const dir = mktmp({ [CONFIG_FILENAME]: '{ this is not json' });
        expect(() => loadAndValidate(dir)).toThrow('webpieces.config.json has invalid JSON');
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
            excludePaths: { rules: ['repositories/**'], guards: ['vendor/**'] },
        }) });
        const loaded = loadAndValidate(dir);
        expect(loaded.excludePaths.rules).toEqual(['repositories/**']);
        expect(loaded.excludePaths.guards).toEqual(['vendor/**']);
    });
});

describe('loadAndValidate — sections & commands', () => {
    it('errors when a guard is left in the rules section (placement)', () => {
        const sections = allRulesOff();
        // Misplace a guard into rules.
        (sections['rules'] as Record<string, unknown>)['pr-creation-guard'] = { mode: 'ON', ignoreModifiedUntilEpoch: 0 };
        const dir = mktmp({ [CONFIG_FILENAME]: JSON.stringify({ ...sections, commands: { 'pr-gate': validPrGate() } }) });
        expect(() => loadAndValidate(dir)).toThrow('belongs in the "hookGuards" section');
    });

    it('errors on a deprecated top-level pr-gate block', () => {
        const dir = mktmp({ [CONFIG_FILENAME]: JSON.stringify({ ...allRulesOff(), 'pr-gate': validPrGate() }) });
        expect(() => loadAndValidate(dir)).toThrow('top-level "pr-gate" block is deprecated');
    });

    it('injects commands.upsertPr as the pr-creation-guard default', () => {
        const sections = allRulesOff();
        const dir = mktmp({ [CONFIG_FILENAME]: JSON.stringify({
            ...sections,
            commands: { 'pr-gate': validPrGate(), upsertPr: 'pnpm my-upsert' },
            excludePaths: validExcludePaths(),
        }) });
        const loaded = loadAndValidate(dir);
        expect(loaded.commands.upsertPr).toBe('pnpm my-upsert');
        const guard = loaded.rulesConfig['pr-creation-guard'] as Record<string, unknown>;
        expect(guard['upsertPrCommand']).toBe('pnpm my-upsert');
    });
});

describe('loadAndValidate — deprecated key aliasing', () => {
    it('accepts the deprecated pr-merge-cleanup key and normalizes it to pr-merge-guard', () => {
        const sections = allRulesOff();
        // Simulate a webpieces.config.json that still uses the OLD guard name (lagging a release).
        const guards = sections.hookGuards as Record<string, unknown>;
        guards['pr-merge-cleanup'] = guards['pr-merge-guard'];
        delete guards['pr-merge-guard'];
        const dir = writeConfig(sections);
        const loaded = loadAndValidate(dir); // must NOT throw on the deprecated key
        expect(loaded.rulesConfig['pr-merge-guard']).toBeDefined();
        expect(loaded.resolved.userConfiguredRuleNames.has('pr-merge-guard')).toBe(true);
        expect(loaded.resolved.userConfiguredRuleNames.has('pr-merge-cleanup')).toBe(false);
    });
});
