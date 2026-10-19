import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { DiffScope, RuleFailError } from '@webpieces/rules-config';
import {
    FileContext,
    NormalizedEdit,
    NormalizedToolInput,
    ProposedFile,
    ToolKind,
    Violation,
    runRuleCheck,
} from '@webpieces/hook-runtime';
import { CatchMustPropagateRule } from '@webpieces/ai-hook-rules';


/**
 * The gate half is loaded by PATH, exactly as rule-pack-catalog.spec loads every pack: this bundle depends
 * on `@webpieces/code-rules` to SHIP it, and a static import from a spec would make the package validator
 * reclassify that shipping dependency as test-only.
 */
const CODE_RULES_SOURCE = path.resolve(__dirname, '../../../../code-rules/src/index.ts');

/** The rule's config entry: the ONE object both runners are built from. Data-only. */
class RuleEntry {
    readonly mode = 'NEW_AND_MODIFIED_CODE';
    readonly forwards = ['warn', 'error'];
    readonly turnOffRuleUntilEpoch = 0;
    readonly turnOffRuleWhileOnBranch = null;
}

/**
 * #1313 acceptance: ONE rule id, ONE config entry, ONE implementation, run by BOTH runners. The same
 * fixture files go through the Write/Edit guard (the proposed file, parsed by SourceAnalysis) and through
 * the build gate (`wp-build`'s validator, over a real git diff), and the two must report the SAME catches
 * at the SAME lines with the SAME diagnosis — for new files and for an edit to an existing one.
 */

const FIXTURES: Readonly<Record<string, string>> = {
    'libs/core/src/MessageCopy.ts': [
        'export class Decoder {',
        '    diagnostic = "";',
        '    decode(raw: string): void {',
        '        try {',
        '            JSON.parse(raw);',
        '        } catch (err: unknown) {',
        '            const error = toError(err);',
        '            this.diagnostic = error.message;',
        '        }',
        '    }',
        '}',
    ].join('\n'),
    'libs/core/src/Mixed.ts': [
        'export class Mixed {',
        '    a(): void {',
        '        try { work(); } catch { return; }',
        '    }',
        '    b(): void {',
        '        try { work(); } catch (err) { log.warn("b failed", err); }',
        '    }',
        '    c(): Promise<void> {',
        '        return run().catch((e) => notify(e.message));',
        '    }',
        '    d(): void {',
        '        try { work(); } catch (err) { report(err); }',
        '    }',
        '    e(): void {',
        '        try {',
        '            work();',
        '            // webpieces-disable catch-must-propagate -- the probe is expected to fail on first run',
        '        } catch (err) {',
        '            return;',
        '        }',
        '    }',
        '    f(): void {',
        '        // webpieces-disable catch-must-propagate',
        '        try { work(); } catch (err) { return; }',
        '    }',
        '}',
    ].join('\n'),
    'libs/core/src/Clean.ts': [
        'export class Clean {',
        '    run(): void {',
        '        try { work(); } catch (err) { throw new Error("wrapped", { cause: err }); }',
        '    }',
        '}',
    ].join('\n'),
};

const LEGACY = 'libs/core/src/Legacy.ts';
const LEGACY_TEXT = [
    'export class Legacy {',
    '    untouched(): void {',
    '        try { work(); } catch (err) { this.text = String(err); }',
    '    }',
    '    edited(): void {',
    '        try { work(); } catch (err) { throw err; }',
    '    }',
    '}',
].join('\n');
const LEGACY_OLD = 'catch (err) { throw err; }';
const LEGACY_NEW = 'catch (err) { this.text = `${err}`; }';

// webpieces-disable no-function-outside-class -- spec-local git helper
function git(root: string, cmd: string): string {
    // core.hooksPath=/dev/null keeps machine-global git hooks out of the throwaway test repo.
    return execSync(`git -c core.hooksPath=/dev/null ${cmd}`, { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

class Workspace {
    readonly root = specTempDirs.makeReal('catch-conformance-');
    readonly config = new RuleEntry();

    constructor() {
        git(this.root, 'init -q -b main');
        git(this.root, 'config user.email test@test.com');
        git(this.root, 'config user.name test');
        this.write(LEGACY, LEGACY_TEXT);
        git(this.root, 'add -A');
        git(this.root, 'commit -q -m base');
        process.env['NX_BASE'] = git(this.root, 'rev-parse HEAD');
        delete process.env['NX_HEAD'];
    }

    write(rel: string, text: string): void {
        fs.mkdirSync(path.dirname(path.join(this.root, rel)), { recursive: true });
        fs.writeFileSync(path.join(this.root, rel), text);
    }

    /** The guard: the hook-side rule, built from the SAME config entry, judging one proposed file. */
    guard(rel: string, tool: ToolKind, edits: readonly NormalizedEdit[]): string[] {
        const file = path.join(this.root, rel);
        const ctx = new FileContext(tool, file, rel, this.root, new ProposedFile(tool, new NormalizedToolInput(file, edits)), 0, 0, 0, 0);
        return runRuleCheck(new CatchMustPropagateRule(this.config), ctx)
            .map((violation: Violation) => `${rel}:${violation.line} — ${violation.message}`);
    }

    /** The gate: the code-rules validator over the working tree's diff from the base commit. */
    async gate(): Promise<string[]> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the throw IS the gate's verdict
        try {
            const codeRules = await import(CODE_RULES_SOURCE);
            const config = Object.assign(new codeRules.CatchMustPropagateConfig(), this.config);
            await new codeRules.CatchMustPropagateValidator(config, new DiffScope(), new codeRules.GateScanScope()).run(this.root);
            return [];
        } catch (err: unknown) {
            //const error = toError(err);
            if (!(err instanceof RuleFailError)) throw err;
            return err.humanMessage.split('\n').filter((line: string) => /^\s+\S+:\d+ — /.test(line)).map((line: string) => line.trim());
        }
    }

    dispose(): void {
        delete process.env['NX_BASE'];
        fs.rmSync(this.root, { recursive: true, force: true });
    }
}

describe('catch-must-propagate — the guard and the gate agree (one rule, one implementation)', () => {
    let workspace: Workspace;

    beforeEach(() => {
        workspace = new Workspace();
    });

    afterEach(() => {
        workspace.dispose();
    });

    it('reports identical findings, line for line, for newly written files', async () => {
        const viaGuard = Object.entries(FIXTURES).flatMap((entry: [string, string]) =>
            workspace.guard(entry[0], 'Write', [new NormalizedEdit('', entry[1], false)]));
        for (const rel of Object.keys(FIXTURES)) workspace.write(rel, FIXTURES[rel]!);
        const viaGate = await workspace.gate();

        expect(viaGuard.sort()).toEqual(viaGate.sort());
        expect(viaGate.map((finding: string) => finding.split(' — ')[0]).sort()).toEqual([
            'libs/core/src/MessageCopy.ts:6',
            'libs/core/src/Mixed.ts:12',
            'libs/core/src/Mixed.ts:24',
            'libs/core/src/Mixed.ts:3',
            'libs/core/src/Mixed.ts:9',
        ]);
    });

    it('reports identical findings for an edit to an existing file: only the touched catch, never the legacy one', async () => {
        const viaGuard = workspace.guard(LEGACY, 'Edit', [new NormalizedEdit(LEGACY_OLD, LEGACY_NEW, false)]);
        workspace.write(LEGACY, LEGACY_TEXT.replace(LEGACY_OLD, LEGACY_NEW));
        const viaGate = await workspace.gate();

        expect(viaGuard).toEqual(viaGate);
        expect(viaGate).toHaveLength(1);
        expect(viaGate[0]).toContain(`${LEGACY}:6 — This catch uses \`err\` only through its text`);
    });
});
