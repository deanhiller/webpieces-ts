import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { ConfigRepairBootstrap, ConfigRepairProbe } from './config-repair-probe';
import { CONFIG_REPAIR_BOOTSTRAP_SOURCE } from './config-repair-bootstrap-source';

describe('dependency-free config repair bootstrap artifact', () => {
    it('is compiled from the real probe with the pinned compiler, independent of the test-host transform', () => {
        const filename = path.join(__dirname, 'config-repair-probe.ts');
        const source = ts.createSourceFile(
            filename,
            fs.readFileSync(filename, 'utf8'),
            ts.ScriptTarget.Latest,
            true,
        );
        const declaration = source.statements.find(
            (statement: ts.Statement) =>
                ts.isClassDeclaration(statement) && statement.name?.text === 'ConfigRepairProbe',
        ) as ts.ClassDeclaration;
        const plain = ts.factory.updateClassDeclaration(
            declaration,
            undefined,
            declaration.name,
            undefined,
            undefined,
            declaration.members,
        );
        const printed = ts.createPrinter().printNode(ts.EmitHint.Unspecified, plain, source);
        const compiled = ts.transpileModule(printed, {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
        }).outputText;
        expect(CONFIG_REPAIR_BOOTSTRAP_SOURCE).toBe(compiled);
    });

    it('executes through real Node with no package binaries and matches canonical repair decisions', () => {
        const root = specTempDirs.make('wp-bootstrap-node-'),
            outside = specTempDirs.make('wp-bootstrap-outside-');
        fs.writeFileSync(
            path.join(root, 'webpieces.config.json'),
            JSON.stringify({
                rulePacks: [{ package: '@client/pack', config: '.webpieces/rules/client.json' }],
            }),
        );
        fs.symlinkSync(outside, path.join(root, 'linked'));
        const probe = new ConfigRepairProbe();
        for (const filename of [
            'webpieces.config.json',
            '.webpieces/rules/client.json',
            '.webpieces/rules.lock.json',
            '.webpieces/instruct-ai/rules-catalog.md',
            'src/client.json',
            'nested/webpieces.config.json',
            'linked/outside.json',
            '../outside.json',
        ]) {
            const child = spawnSync(
                process.execPath,
                ['-e', new ConfigRepairBootstrap().script(), root, filename],
                { encoding: 'utf8' },
            );
            expect(child.status === 0, child.stderr || filename).toBe(
                probe.isRepairFile(root, filename),
            );
        }
    });

    it('allows complete repair patches and rejects mixed writes, deletions and moves', () => {
        const root = specTempDirs.make('wp-bootstrap-patch-');
        fs.writeFileSync(
            path.join(root, 'webpieces.config.json'),
            JSON.stringify({ rulePacks: [{ package: '@client/pack', config: 'owner.json' }] }),
        );
        const probe = new ConfigRepairProbe();
        const patch = '*** Begin Patch\n*** Update File: owner.json\n@@\n-{}\n+{}\n*** End Patch';
        expect(probe.isRepairPatch(root, patch)).toBe(true);
        expect(probe.isRepairPatch(root, patch.replace('owner.json', 'src/other.json'))).toBe(
            false,
        );
        expect(
            probe.isRepairPatch(
                root,
                patch.replace('*** End Patch', '*** Add File: src/other.json\n+{}\n*** End Patch'),
            ),
        ).toBe(false);
        expect(
            probe.isRepairPatch(
                root,
                '*** Begin Patch\n*** Delete File: owner.json\n*** End Patch',
            ),
        ).toBe(false);
        expect(probe.isRepairPatch(root, patch.replace('@@', '*** Move to: other.json\n@@'))).toBe(
            false,
        );
        const child = spawnSync(
            process.execPath,
            ['-e', new ConfigRepairBootstrap().callScript(), root],
            {
                input: JSON.stringify({ tool_name: 'apply_patch', tool_input: { command: patch } }),
                encoding: 'utf8',
            },
        );
        expect(child.status, child.stderr).toBe(0);
    });
});
