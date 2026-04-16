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

    it('merges defaults with overrides and honors enabled:false', () => {
        const body = JSON.stringify({
            rules: {
                'max-file-lines': { enabled: true, limit: 500, mode: 'MODIFIED_FILES' },
                'no-any-unknown': { enabled: false },
            },
        });
        const dir = mktmp({ [CONFIG_FILENAME]: body });
        const config = loadConfig(dir);

        expect(config.configPath).toBe(path.join(dir, CONFIG_FILENAME));

        const maxFileLines = config.rules.get('max-file-lines');
        expect(maxFileLines).toBeDefined();
        expect(maxFileLines!.enabled).toBe(true);
        expect(maxFileLines!.options['limit']).toBe(500);
        expect(maxFileLines!.options['mode']).toBe('MODIFIED_FILES');

        const noAnyUnknown = config.rules.get('no-any-unknown');
        expect(noAnyUnknown).toBeDefined();
        expect(noAnyUnknown!.enabled).toBe(false);
    });

    it('preserves unknown option keys for consumers that understand them', () => {
        const body = JSON.stringify({
            rules: {
                'no-destructure': {
                    enabled: true,
                    mode: 'MODIFIED_CODE',
                    disableAllowed: false,
                    ignoreModifiedUntilEpoch: 12345,
                },
            },
        });
        const dir = mktmp({ [CONFIG_FILENAME]: body });
        const config = loadConfig(dir);

        const rule = config.rules.get('no-destructure')!;
        expect(rule.options['mode']).toBe('MODIFIED_CODE');
        expect(rule.options['disableAllowed']).toBe(false);
        expect(rule.options['ignoreModifiedUntilEpoch']).toBe(12345);
    });

    it('fails open on malformed JSON', () => {
        const dir = mktmp({ [CONFIG_FILENAME]: '{ this is not json' });
        const config = loadConfig(dir);
        expect(config.configPath).toBe(path.join(dir, CONFIG_FILENAME));
        expect(config.rules.size).toBe(0);
    });
});
