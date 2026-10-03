import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { InformAiError } from '@webpieces/tooling-common';
import { PackPolicyFiles } from './pack-policy-files';

/** The framework discovers only client declarations; invalid files remain actionable errors. */
describe('explicit client pack selection', () => {
    it('rejects missing selection instead of implicitly loading built-in owners', () => {
        const root = specTempDirs.make('wp-missing-selection-');
        const selection = new PackPolicyFiles();
        expect(() => selection.declarations(undefined, root)).toThrow('rulePacks is required');
        fs.writeFileSync(
            path.join(root, 'package.json'),
            '{"webpieces":{"rulePacks":[{"module":"@webpieces/code-rules/rule-pack"}]}}',
        );
        expect(() => selection.declarations(undefined, root)).toThrow('rulePacks is required');
        expect(() => selection.declarations(undefined, root)).toThrow(InformAiError);
    });

    it('rejects malformed declarations and reports missing modules as repairable client errors', () => {
        const root = specTempDirs.make('wp-bad-selection-');
        const file = path.join(root, 'package.json');
        const selection = new PackPolicyFiles();
        fs.writeFileSync(file, '{"private":true}');
        expect(() => selection.declarations([{ package: 12, config: 'owner.json' }], root)).toThrow(
            'Invalid rulePacks entry',
        );
        const declarations = selection.declarations(
            [{ package: './absent.cjs', config: 'owner.json' }],
            root,
        );
        expect(() => selection.select(root, declarations)).toThrow('Rule-pack selection');
        expect(() => selection.select(root, declarations)).toThrow('webpieces.config.json');
        expect(() => selection.select(root, declarations)).toThrow(InformAiError);
    });
});
