import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { ConfigRepairBootstrap, ConfigRepairProbe } from './config-repair-probe';
import { CONFIG_REPAIR_BOOTSTRAP_SOURCE } from './config-repair-bootstrap-source';
import { MANIFEST_FILENAMES } from './hook-config-diagnostics';

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
                rulePacks: [{ package: '@client/pack', config: '.webpieces-config/rules/client.json' }],
            }),
        );
        fs.symlinkSync(outside, path.join(root, 'linked'));
        const probe = new ConfigRepairProbe();
        for (const filename of [
            'webpieces.config.json',
            '.gitignore',
            '.webpieces-config/rules/client.json',
            '.webpieces-config/rules/new-owner.json',
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

    /**
     * THE ONE EDIT ESCAPE (#1448), judged by the compiled bootstrap through real Node exactly as the
     * shim runs it: every touched path must be a repair file or a governed-root manifest, or the whole
     * edit is refused with one line per offending path.
     */
    class ProbeRun {
        constructor(
            readonly status: number | null,
            readonly stdout: string,
        ) {}
    }

    function verdict(root: string, payload: object): ProbeRun {
        const child = spawnSync(process.execPath, ['-e', new ConfigRepairBootstrap().callScript(), root], {
            input: JSON.stringify(payload),
            encoding: 'utf8',
        });
        return new ProbeRun(child.status, child.stdout);
    }

    function stageRoot(): string {
        const root = fs.realpathSync(specTempDirs.make('wp-bootstrap-patch-'));
        fs.writeFileSync(
            path.join(root, 'webpieces.config.json'),
            JSON.stringify({ rulePacks: [{ package: '@client/pack', config: 'owner.json' }] }),
        );
        fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
        fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'catalog: {}\n');
        fs.mkdirSync(path.join(root, 'packages', 'lib'), { recursive: true });
        fs.writeFileSync(path.join(root, 'packages', 'lib', 'package.json'), '{}\n');
        return root;
    }

    function update(file: string): string {
        return `*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch`;
    }

    it('permits a patch of each advertised file and labels it, through the compiled bootstrap', () => {
        const root = stageRoot();
        const probe = new ConfigRepairProbe();
        for (const [file, label] of [
            ['owner.json', 'config'],
            ['webpieces.config.json', 'config'],
            ['pnpm-workspace.yaml', 'manifest'],
            ['package.json', 'manifest'],
            [path.join(root, 'package.json'), 'manifest'],
        ]) {
            const payload = { tool_name: 'apply_patch', cwd: root, tool_input: { command: update(file) } };
            expect(verdict(root, payload), file).toEqual(new ProbeRun(0, label));
            expect(probe.recoveryVerdict(root, 'apply_patch', '', update(file)), file).toEqual([label]);
        }
        // A namespace-qualified Codex tool name is the same tool.
        const qualified = { tool_name: 'functions.apply_patch', cwd: root, tool_input: { command: update('pnpm-workspace.yaml') } };
        expect(verdict(root, qualified)).toEqual(new ProbeRun(0, 'manifest'));
    });

    it('refuses mixed, nested-manifest, traversal, delete and move patches atomically, naming each path', () => {
        const root = stageRoot();
        const mixed = update('pnpm-workspace.yaml').replace('*** End Patch', '*** Add File: src/evil.ts\n+x\n*** End Patch');
        for (const [patch, offender] of [
            [mixed, 'Add src/evil.ts'],
            [update('packages/lib/package.json'), 'Update packages/lib/package.json'],
            [update('../outside/package.json'), 'Update ../outside/package.json'],
            ['*** Begin Patch\n*** Delete File: package.json\n*** End Patch', 'Delete package.json'],
            [update('src/a.ts').replace('@@', '*** Move to: package.json\n@@'), 'Update src/a.ts'],
            [update('package.json').replace('@@', '*** Move to: src/b.json\n@@'), 'Move src/b.json'],
        ]) {
            const result = verdict(root, { tool_name: 'apply_patch', cwd: root, tool_input: { command: patch } });
            expect(result.status, patch).toBe(3);
            expect(result.stdout, patch).toContain(offender);
            expect(result.stdout, patch).not.toContain('Update pnpm-workspace.yaml');
        }
        const notAPatch = verdict(root, { tool_name: 'apply_patch', cwd: root, tool_input: { command: 'rm -rf /' } });
        expect(notAPatch.status).toBe(3);
    });

    it('gives Claude Write/Edit the same answer as the same Codex patch, and has no opinion on other tools', () => {
        const root = stageRoot();
        for (const file of ['package.json', 'pnpm-workspace.yaml', 'webpieces.config.json', 'src/x.ts', 'packages/lib/package.json']) {
            const claude = verdict(root, { tool_name: 'Edit', cwd: root, tool_input: { file_path: path.join(root, file) } });
            const codex = verdict(root, { tool_name: 'apply_patch', cwd: root, tool_input: { command: update(file) } });
            expect(claude.status, file).toBe(codex.status);
        }
        expect(verdict(root, { tool_name: 'Bash', cwd: root, tool_input: { command: 'pnpm install' } }).status).toBe(1);
        expect(verdict(root, { tool_name: 'Read', cwd: root, tool_input: { file_path: 'package.json' } }).status).toBe(1);
    });

    it('names its manifests with the same two filenames the rest of webpieces uses', () => {
        expect([...MANIFEST_FILENAMES].sort()).toEqual(['package.json', 'pnpm-workspace.yaml']);
    });
});

