import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { InformAiError } from '@webpieces/tooling-common';
import { RulePackSelection } from './rule-pack-selection';

/** The framework discovers only client declarations; invalid files remain actionable errors. */
describe('explicit client pack selection', () => {
    it('rejects missing selection instead of implicitly loading built-in owners', () => {
        const root = specTempDirs.make('wp-missing-selection-');
        const selection = new RulePackSelection();
        expect(() => selection.loadFrom(root)).toThrow('Declare webpieces.rulePacks');
        fs.writeFileSync(path.join(root, 'package.json'), '{"private":true}');
        expect(() => selection.loadFrom(root)).toThrow('no built-in pack fallback');
        expect(() => selection.loadFrom(root)).toThrow(InformAiError);
    });

    it('rejects malformed declarations and reports missing modules as repairable client errors', () => {
        const root = specTempDirs.make('wp-bad-selection-');
        const file = path.join(root, 'package.json');
        const selection = new RulePackSelection();
        fs.writeFileSync(file, '{"webpieces":{"rulePacks":[{"module":12}]}}');
        expect(() => selection.loadFrom(root)).toThrow('Invalid webpieces.rulePacks entry');
        fs.writeFileSync(file, '{"webpieces":{"rulePacks":[{"module":"./absent.cjs"}]}}');
        expect(() => selection.loadFrom(root)).toThrow('repair the module declarations');
        expect(() => selection.loadFrom(root)).toThrow(InformAiError);
        fs.writeFileSync(file, '{');
        expect(() => selection.loadFrom(root)).toThrow(InformAiError);
    });
});
