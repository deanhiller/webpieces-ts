import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { CONFIG_FILENAME, RECOVERY_EDIT_STILL_ALLOWED } from '@webpieces/rules-config';
import { ShimRun, ShimTestkit } from './shim-testkit';
import { shimStaleRecoveryDecision } from '../adapters/hook-core';
import { shimStaleDenyReason } from './shim-deny-reason';
import { CodexAdapter, FileOperation, NormalizedToolInput } from '@webpieces/hook-runtime';
import { run as runRules } from '../core/runner';

/**
 * ISSUE #1448 — the L0 edit escape, driven through the REAL rendered shim on a real /bin/sh with the
 * envelope shapes each harness actually sends.
 *
 * Every L0 deny promises that an edit of webpieces.config.json, pnpm-workspace.yaml or package.json is
 * still allowed. In a consumer repo under version drift (pin 0.4.1003, node_modules 0.4.1001, `pnpm
 * install` failing on a stale patchedDependencies entry) a Codex agent tried to make exactly that edit
 * with `apply_patch` and was refused by the same deny that promised it: the shim's manifest arm read
 * only `tool_input.file_path`, and Codex carries its patch in `tool_input.command`. The audit line of
 * that refusal recorded `tool=apply_patch ai=codex fault=D DENY-STALE` — the hook received the plain
 * tool name even though the agent dispatched it through `functions.exec`, so the defect was the shim's
 * field scrape, not the name.
 *
 * Each case below asserts the decision the AGENT sees, not a predicate's return value: allow means the
 * shim printed no deny, deny means it printed one whose reason names the offending path.
 */
const kit = new ShimTestkit();

/**
 * A Codex PreToolUse envelope, SANITIZED from the captured consumer shape: Claude's key names plus the
 * Codex additions measured from codex-cli (`model`, `turn_id`, `tool_use_id`, `permission_mode`,
 * `agent_type`, `agent_id`). Every identifier is a placeholder; nothing from the consumer repo survives.
 */
function codexEnvelope(toolName: string, patch: string, cwd: string): string {
    return JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'sess-sanitized',
        transcript_path: '/dev/null',
        cwd,
        model: 'gpt-codex',
        turn_id: 'turn-sanitized',
        tool_use_id: 'call_sanitized',
        permission_mode: 'default',
        agent_type: 'default',
        agent_id: '',
        tool_name: toolName,
        tool_input: { command: patch },
    });
}

/** A Claude Code Write/Edit envelope for the same target. */
function claudeEnvelope(toolName: string, filePath: string, cwd: string): string {
    return JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'sess-sanitized',
        transcript_path: '/dev/null',
        cwd,
        tool_name: toolName,
        tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' },
    });
}

function update(file: string, before: string, after: string): string {
    return `*** Begin Patch\n*** Update File: ${file}\n@@\n-${before}\n+${after}\n*** End Patch`;
}

const PIN_1003 = "  '@webpieces/pr-gate': &wp 0.4.1003";
const PIN_1001 = "  '@webpieces/pr-gate': &wp 0.4.1001";
const STALE_PATCH = '"@webpieces/openapi-generator@0.4.1001": "patches/openapi-generator.patch"';

/**
 * The consumer's state, staged: the runtime pin raised to 0.4.1003 in pnpm-workspace.yaml's catalog
 * (the `&wp` anchor form), node_modules still on 0.4.1001, and a patchedDependencies entry registered
 * against the OLD version — the entry that made `pnpm install` fail with ERR_PNPM_UNUSED_PATCH, so
 * re-running the install could never clear the drift.
 */
function stageConsumerDrift(): string {
    const root = fs.realpathSync(kit.stageDriftRoot('0.4.1003', '0.4.1001'));
    fs.writeFileSync(path.join(root, CONFIG_FILENAME), '{}\n');
    fs.writeFileSync(path.join(root, 'package.json'), [
        '{',
        '  "devDependencies": { "@webpieces/pr-gate": "catalog:" },',
        `  "pnpm": { "patchedDependencies": { ${STALE_PATCH} } }`,
        '}',
        '',
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), `catalog:\n${PIN_1003}\n`);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const a = 1;\n');
    fs.mkdirSync(path.join(root, 'packages', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages', 'lib', 'package.json'), '{}\n');
    return root;
}

function run(root: string, stdin: string): ShimRun {
    return kit.runShim(root, 'wp-ai-guards-hook', stdin);
}

/** The deny is fault D, from L0, and the bin never ran. */
function expectDriftDeny(out: ShimRun, why: string): string {
    expect(out.isDenied(), `${why}: expected a deny, got ${out.stdout}`).toBe(true);
    expect(out.stdout).not.toContain('EXECED');
    const reason = out.denyReason();
    expect(reason).toContain('version drift');
    return reason;
}

function expectAllowed(out: ShimRun, why: string): void {
    expect(out.isDenied(), `${why}: the recovery edit was DENIED: ${out.stdout}`).toBe(false);
    // Terminal at L0: the guard bin is the stale side and must not run.
    expect(out.stdout, why).not.toContain('EXECED');
}

describe('fault D: every advertised recovery edit is typable with Codex apply_patch (#1448)', () => {
    it('rolls back the failed runtime upgrade in pnpm-workspace.yaml — relative, absolute and namespace-qualified', () => {
        const root = stageConsumerDrift();
        const rollback = update('pnpm-workspace.yaml', PIN_1003, PIN_1001);
        expectAllowed(run(root, codexEnvelope('apply_patch', rollback, root)), 'relative path');
        const absolute = update(path.join(root, 'pnpm-workspace.yaml'), PIN_1003, PIN_1001);
        expectAllowed(run(root, codexEnvelope('apply_patch', absolute, root)), 'absolute path');
        expectAllowed(run(root, codexEnvelope('functions.apply_patch', rollback, root)), 'functions.apply_patch');
        expectAllowed(run(root, codexEnvelope('tools.apply_patch', rollback, root)), 'tools.apply_patch');
        // A relative path resolves against the envelope's cwd, wherever inside the tree that is.
        const fromSubdir = update('../pnpm-workspace.yaml', PIN_1003, PIN_1001);
        expect(run(root, codexEnvelope('apply_patch', fromSubdir, path.join(root, 'src'))).isDenied(),
            'a .. segment is refused even when it lands on a manifest').toBe(true);
    });

    it('allows the forward pin edit, the patch-registration repair, and a config edit — all three files', () => {
        const root = stageConsumerDrift();
        expectAllowed(run(root, codexEnvelope('apply_patch', update('pnpm-workspace.yaml', PIN_1001, PIN_1003), root)), 'forward pin');
        const repair = update('package.json', `  "pnpm": { "patchedDependencies": { ${STALE_PATCH} } }`, '  "pnpm": { "patchedDependencies": {} }');
        expectAllowed(run(root, codexEnvelope('apply_patch', repair, root)), 'patchedDependencies repair');
        expectAllowed(run(root, codexEnvelope('apply_patch', update(CONFIG_FILENAME, '{}', '{ }'), root)), 'webpieces.config.json');
        const both = '*** Begin Patch\n*** Update File: package.json\n@@\n-a\n+b\n*** Update File: pnpm-workspace.yaml\n@@\n-a\n+b\n*** End Patch';
        expectAllowed(run(root, codexEnvelope('apply_patch', both, root)), 'one patch, two manifests');
    });

    it('gives the SAME decision for a Claude Write/Edit and a Codex apply_patch of the same file', () => {
        const root = stageConsumerDrift();
        for (const file of ['pnpm-workspace.yaml', 'package.json', CONFIG_FILENAME, 'src/index.ts', 'packages/lib/package.json']) {
            const codex = run(root, codexEnvelope('apply_patch', update(file, 'a', 'b'), root)).isDenied();
            for (const tool of ['Write', 'Edit', 'MultiEdit']) {
                const claude = run(root, claudeEnvelope(tool, path.join(root, file), root)).isDenied();
                expect(claude, `${tool} vs apply_patch disagree on ${file}`).toBe(codex);
            }
        }
    });

    it('still blocks ordinary code, nested manifests, mixed patches, traversal, deletes, escaping moves and shell edits', () => {
        const root = stageConsumerDrift();
        const refusals: ReadonlyArray<readonly [string, string]> = [
            [update('src/index.ts', 'a', 'b'), 'src/index.ts'],
            [update('packages/lib/package.json', 'a', 'b'), 'packages/lib/package.json'],
            [update('pnpm-workspace.yaml', PIN_1003, PIN_1001).replace('*** End Patch', '*** Add File: src/smuggled.ts\n+x\n*** End Patch'), 'src/smuggled.ts'],
            [update('../outside/package.json', 'a', 'b'), '../outside/package.json'],
            ['*** Begin Patch\n*** Delete File: package.json\n*** End Patch', 'Delete package.json'],
            [update('src/index.ts', 'a', 'b').replace('@@', '*** Move to: package.json\n@@'), 'src/index.ts'],
            [update('package.json', 'a', 'b').replace('@@', '*** Move to: src/renamed.json\n@@'), 'src/renamed.json'],
        ];
        for (const [patch, offender] of refusals) {
            const reason = expectDriftDeny(run(root, codexEnvelope('apply_patch', patch, root)), offender);
            expect(reason, 'the deny must name the file that was refused').toContain(offender);
            expect(reason).toContain('REFUSED as a whole');
        }
        // The mixed patch must not be half-applied: its manifest is reported fine, only the smuggled file is named.
        const mixed = expectDriftDeny(run(root, codexEnvelope('apply_patch', refusals[2][0], root)), 'mixed');
        expect(mixed).not.toContain('Update pnpm-workspace.yaml:');
        // A shell mutation is not an edit tool, and the escape is not a shell escape.
        const perl = `perl -pi -e 's/&wp 0\\.4\\.1003/&wp 0.4.1001/' pnpm-workspace.yaml`;
        expectDriftDeny(run(root, kit.bashPayload(perl)), 'perl rollback');
        // Requirement 8, pinned as it stands: GitHub reporting and wp-sync-main are NOT on the L0 list (a
        // policy decision for a human), while read-only git orientation is.
        expectDriftDeny(run(root, codexEnvelope('Bash', 'gh issue list', root)), 'gh issue list');
        expectDriftDeny(run(root, codexEnvelope('Bash', 'pnpm wp-sync-main', root)), 'pnpm wp-sync-main');
        expect(run(root, codexEnvelope('Bash', 'git log', root)).isDenied(), 'read-only orientation').toBe(false);
        expectDriftDeny(run(root, claudeEnvelope('Edit', path.join(root, 'src', 'index.ts'), root)), 'Claude source edit');
        // Read stays allowed, exactly as before.
        expect(run(root, kit.readPayload(path.join(root, 'package.json'))).isDenied()).toBe(false);
    });

    it('names the Codex tool and the install-failure path in the deny', () => {
        const root = stageConsumerDrift();
        const reason = expectDriftDeny(run(root, kit.bashPayload('pnpm build')), 'ordinary bash');
        expect(reason).toContain(RECOVERY_EDIT_STILL_ALLOWED);
        expect(reason).toContain('Codex apply_patch');
        expect(reason).toContain('ERR_PNPM_UNUSED_PATCH');
        expect(reason).not.toContain('any Write/Edit whose target is');
    });

    it('reproduces the consumer incident end to end: repair the manifests with Codex, and the drift clears without bypassing a hook', () => {
        const root = stageConsumerDrift();
        // Before: an ordinary call is blocked by fault D.
        expectDriftDeny(run(root, kit.bashPayload('pnpm build')), 'before the repair');
        // The agent repairs BOTH manifests through apply_patch: roll the pin back and drop the stale patch.
        const rollback = update('pnpm-workspace.yaml', PIN_1003, PIN_1001);
        expectAllowed(run(root, codexEnvelope('apply_patch', rollback, root)), 'rollback');
        // The harness applies the allowed patch — written here as its effect on disk.
        const ws = path.join(root, 'pnpm-workspace.yaml');
        fs.writeFileSync(ws, fs.readFileSync(ws, 'utf8').replace(PIN_1003, PIN_1001));
        const pkg = path.join(root, 'package.json');
        fs.writeFileSync(pkg, fs.readFileSync(pkg, 'utf8').replace(STALE_PATCH, ''));
        // The cure the deny prescribes is still reachable…
        expect(run(root, kit.bashPayload('pnpm install')).isDenied()).toBe(false);
        // …and with pin and node_modules agreeing, the next ordinary call reaches the real guard bin.
        const after = run(root, kit.bashPayload('pnpm build'));
        expect(after.isDenied(), after.stdout).toBe(false);
        expect(after.stdout).toContain('EXECED');
    });

    it('records the manifest edit as ALLOW-MANIFEST with the Codex harness on the same audit line', () => {
        const root = stageConsumerDrift();
        run(root, codexEnvelope('apply_patch', update('pnpm-workspace.yaml', PIN_1003, PIN_1001), root));
        const dir = path.join(root, '.webpieces', 'logs', 'L0-shim');
        const body = fs.readdirSync(dir).map((f: string): string => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
        expect(body).toMatch(/apply_patch\tai=codex\t.*fault=D\tALLOW-MANIFEST/);
    });
});

/**
 * THE REGRESSION MATRIX across every OTHER L0 fault sharing the same promise. X/U/K are decided by the
 * same sh arm as D; S is decided in the binary by isAllowed(), which runs the identical compiled probe.
 */
describe('every L0 fault that advertises the edit escape honours it for apply_patch', () => {
    function stageWithManifests(root: string): string {
        const real = fs.realpathSync(root);
        fs.writeFileSync(path.join(real, CONFIG_FILENAME), '{}\n');
        fs.writeFileSync(path.join(real, 'pnpm-workspace.yaml'), `catalog:\n${PIN_1003}\n`);
        return real;
    }

    function stageCrashedBin(): string {
        const root = kit.stageDriftRoot('1.0.0', '1.0.0');
        fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'wp-ai-guards-hook'),
            '#!/bin/sh\nprintf "Cannot find module x" >&2\nexit 1\n', { mode: 0o755 });
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
            dependencies: { '@webpieces/pr-gate': '1.0.0' },
            devDependencies: { '@webpieces/agent-workflow-rules': '1.0.0' },
        }, null, 2) + '\n');
        return root;
    }

    const FAULTS: ReadonlyArray<readonly [string, () => string]> = [
        ['X (bin missing, package declared)', (): string => kit.stageDeclaredRoot()],
        ['U (bin missing, package undeclared)', (): string => kit.mktmp()],
        ['K (bin present but crashed)', stageCrashedBin],
    ];

    it.each(FAULTS)('fault %s allows a manifest patch and refuses a code patch', (_name: string, stage: () => string) => {
        const root = stageWithManifests(stage());
        for (const file of ['pnpm-workspace.yaml', 'package.json', CONFIG_FILENAME]) {
            const out = run(root, codexEnvelope('apply_patch', update(file, 'a', 'b'), root));
            expect(out.isDenied(), `${file}: ${out.stdout}`).toBe(false);
        }
        const code = run(root, codexEnvelope('apply_patch', update('src/index.ts', 'a', 'b'), root));
        expect(code.isDenied()).toBe(true);
        expect(code.denyReason()).toContain('src/index.ts');
        expect(code.denyReason()).toContain(RECOVERY_EDIT_STILL_ALLOWED);
    });

    it('fault S (stale committed shim) admits the same patches and refuses the same patches', () => {
        const root = stageWithManifests(kit.mktmp());
        fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
        const at = (file: string): string => path.join(root, file);
        expect(shimStaleRecoveryDecision('apply_patch', update(at('pnpm-workspace.yaml'), 'a', 'b'), '', 'codex')).toBe('pass');
        expect(shimStaleRecoveryDecision('functions.apply_patch', update(at('package.json'), 'a', 'b'), '', 'codex')).toBe('pass');
        expect(shimStaleRecoveryDecision('Edit', '', at('pnpm-workspace.yaml'), 'claude-code')).toBe('pass');
        const mixed = update(at('package.json'), 'a', 'b').replace('*** End Patch', `*** Add File: ${at('src/x.ts')}\n+x\n*** End Patch`);
        expect(shimStaleRecoveryDecision('apply_patch', mixed, '', 'codex')).toBe('deny');
        expect(shimStaleRecoveryDecision('apply_patch', `*** Begin Patch\n*** Delete File: ${at('package.json')}\n*** End Patch`, '', 'codex')).toBe('deny');
        expect(shimStaleDenyReason('0.4.1', root, ['ai-hook.sh'], false)).toContain(RECOVERY_EDIT_STILL_ALLOWED);
    });
});

/**
 * The HEALTHY-tree half of the same normalization: a namespace-qualified Codex edit is still an edit (an
 * `Ignored` mapping would wave it past every guard), and a Move ONTO a recovery file is not exempt from
 * the rules, because its source is deleted.
 */
describe('a healthy tree judges a namespace-qualified apply_patch and a Move onto a manifest', () => {
    it('maps functions.apply_patch and tools.apply_patch to a File event with every target', () => {
        const root = fs.realpathSync(kit.mktmp());
        const patch = update('package.json', 'a', 'b').replace('@@', '*** Move to: src/x.json\n@@');
        for (const name of ['apply_patch', 'functions.apply_patch', 'tools.apply_patch']) {
            const event = new CodexAdapter().toEvent({ tool_name: name, tool_input: { command: patch }, turn_id: 't1' }, root);
            expect(event.kind, name).toBe('File');
            expect(event.files.map((f: FileOperation): string => f.input.sourcePath), name).toEqual([path.join(root, 'package.json')]);
            expect(event.files.map((f: FileOperation): string => f.input.filePath), name).toEqual([path.join(root, 'src', 'x.json')]);
        }
        expect(new CodexAdapter().toEvent({ tool_name: 'functions.exec', tool_input: {}, turn_id: 't1' }, root).kind).toBe('Ignored');
    });

    it('does not exempt a Move of code onto the root package.json from the rules runner', () => {
        const root = fs.realpathSync(kit.mktmp());
        fs.writeFileSync(path.join(root, CONFIG_FILENAME), '{}\n');
        fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
        const inPlace = new NormalizedToolInput(path.join(root, 'package.json'), []);
        expect(runRules('Edit', inPlace, root, 'all')).toBeNull();
        const moved = new NormalizedToolInput(path.join(root, 'package.json'), []);
        moved.sourcePath = path.join(root, 'src', 'index.ts');
        // Not exempt: it goes on to be judged — with this deliberately empty config that judgement is the
        // config-validation refusal, which the in-place edit above never reaches.
        expect(() => runRules('Edit', moved, root, 'all')).toThrow(/webpieces\.config\.json/);
    });
});
