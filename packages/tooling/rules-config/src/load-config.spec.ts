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

// Minimal valid config — every built-in rule present, all OFF with the now-required
// ignoreModifiedUntilEpoch (0 = active), plus a valid pr-gate block (also now required).
const ALL_RULE_NAMES = [
    'max-method-lines', 'max-file-lines', 'require-return-type', 'no-inline-type-literals',
    'no-any-unknown', 'no-implicit-any', 'prisma-validate-dtos', 'prisma-converter',
    'no-destructure', 'no-unmanaged-exceptions', 'catch-error-pattern', 'throw-cause-required',
    'angular-no-direct-api-in-resolver', 'no-symbol-di-tokens', 'no-shell-substitution',
    'branch-creation-guard', 'pr-creation-guard', 'merge-in-progress-guard', 'pr-merge-cleanup',
    'no-direct-main-update', 'no-edit-on-main', 'no-file-import-cycles', 'runtime-architecture',
    'no-js-files', 'validate-ts-in-src',
];

function allRulesOff(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const base: Record<string, unknown> = {};
    for (const name of ALL_RULE_NAMES) {
        base[name] = { mode: 'OFF', ignoreModifiedUntilEpoch: 0 };
    }
    return { ...base, ...overrides };
}

function validPrGate(): Record<string, unknown> {
    return { mode: 'ON', buildCommand: 'echo ci' };
}

function writeConfig(rules: Record<string, unknown>, prGate: unknown = validPrGate()): string {
    return mktmp({ [CONFIG_FILENAME]: JSON.stringify({ rules, 'pr-gate': prGate }) });
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
            'max-file-lines': { limit: 500, mode: 'MODIFIED_FILES', ignoreModifiedUntilEpoch: 0 },
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
            'no-destructure': { mode: 'MODIFIED_CODE', disableAllowed: false, ignoreModifiedUntilEpoch: 12345 },
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
        const dir = mktmp({ [CONFIG_FILENAME]: JSON.stringify({ rules: {}, 'pr-gate': validPrGate() }) });
        expect(() => loadAndValidate(dir)).toThrow('Not configured in webpieces.config.json');
    });

    it('throws when the pr-gate block is missing entirely', () => {
        const dir = mktmp({ [CONFIG_FILENAME]: JSON.stringify({ rules: allRulesOff() }) });
        expect(() => loadAndValidate(dir)).toThrow('[pr-gate] Not configured');
    });
});
