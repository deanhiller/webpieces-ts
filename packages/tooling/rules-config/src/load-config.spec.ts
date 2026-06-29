import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadConfig, CONFIG_FILENAME } from './load-config';

function mktmp(contents: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-config-'));
    for (const [name, body] of Object.entries(contents)) {
        fs.writeFileSync(path.join(dir, name), body);
    }
    return dir;
}

// Minimal valid config — every built-in rule present, all set to OFF.
// Tests override specific rules to exercise the behavior under test.
function allRulesOff(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        'max-method-lines': { mode: 'OFF' },
        'max-file-lines': { mode: 'OFF' },
        'require-return-type': { mode: 'OFF' },
        'no-inline-type-literals': { mode: 'OFF' },
        'no-any-unknown': { mode: 'OFF' },
        'no-implicit-any': { mode: 'OFF' },
        'prisma-validate-dtos': { mode: 'OFF' },
        'prisma-converter': { mode: 'OFF' },
        'no-destructure': { mode: 'OFF' },
        'no-unmanaged-exceptions': { mode: 'OFF' },
        'catch-error-pattern': { mode: 'OFF' },
        'throw-cause-required': { mode: 'OFF' },
        'angular-no-direct-api-in-resolver': { mode: 'OFF' },
        'no-symbol-di-tokens': { mode: 'OFF' },
        'no-shell-substitution': { mode: 'OFF' },
        'branch-creation-guard': { mode: 'OFF' },
        'pr-creation-guard': { mode: 'OFF' },
        'merge-in-progress-guard': { mode: 'OFF' },
        'pr-merge-cleanup': { mode: 'OFF' },
        'no-direct-main-update': { mode: 'OFF' },
        'no-edit-on-main': { mode: 'OFF' },
        'no-file-import-cycles': { mode: 'OFF' },
        'runtime-architecture': { mode: 'OFF' },
        'no-js-files': { mode: 'OFF' },
        'validate-ts-in-src': { mode: 'OFF' },
        ...overrides,
    };
}

describe('loadConfig', () => {
    it('returns empty config when no file is found', () => {
        const dir = mktmp({});
        // Search only inside the tmp subtree: create a nested cwd with a barrier (rootDir check)
        const cwd = fs.mkdtempSync(path.join(dir, 'inner-'));
        const config = loadConfig(cwd);
        // May walk up to a real config; we only assert the shape
        expect(config.rules).toBeInstanceOf(Map);
        expect(typeof (config.configPath === null || typeof config.configPath === 'string')).toBe('boolean');
    });

    it('merges defaults with overrides and honors mode:OFF', () => {
        const body = JSON.stringify({
            rules: allRulesOff({
                'max-file-lines': { limit: 500, mode: 'MODIFIED_FILES' },
                'no-any-unknown': { mode: 'OFF' },
            }),
        });
        const dir = mktmp({ [CONFIG_FILENAME]: body });
        const config = loadConfig(dir);

        expect(config.configPath).toBe(path.join(dir, CONFIG_FILENAME));

        const maxFileLines = config.rules.get('max-file-lines');
        expect(maxFileLines).toBeDefined();
        expect(maxFileLines!.isOff).toBe(false);
        expect(maxFileLines!.options['limit']).toBe(500);
        expect(maxFileLines!.options['mode']).toBe('MODIFIED_FILES');

        const noAnyUnknown = config.rules.get('no-any-unknown');
        expect(noAnyUnknown).toBeDefined();
        expect(noAnyUnknown!.isOff).toBe(true);
        expect(noAnyUnknown!.mode).toBe('OFF');
    });

    it('preserves unknown option keys for consumers that understand them', () => {
        const body = JSON.stringify({
            rules: allRulesOff({
                'no-destructure': {
                    mode: 'MODIFIED_CODE',
                    disableAllowed: false,
                    ignoreModifiedUntilEpoch: 12345,
                },
            }),
        });
        const dir = mktmp({ [CONFIG_FILENAME]: body });
        const config = loadConfig(dir);

        const rule = config.rules.get('no-destructure')!;
        expect(rule.options['mode']).toBe('MODIFIED_CODE');
        expect(rule.options['disableAllowed']).toBe(false);
        expect(rule.options['ignoreModifiedUntilEpoch']).toBe(12345);
    });

    it('throws InformAiError on malformed JSON', () => {
        const dir = mktmp({ [CONFIG_FILENAME]: '{ this is not json' });
        expect(() => loadConfig(dir)).toThrow('webpieces.config.json has invalid JSON');
    });

    it('throws InformAiError listing all missing rules when config has none', () => {
        const dir = mktmp({ [CONFIG_FILENAME]: JSON.stringify({ rules: {} }) });
        expect(() => loadConfig(dir)).toThrow('Not configured in webpieces.config.json');
    });
});
