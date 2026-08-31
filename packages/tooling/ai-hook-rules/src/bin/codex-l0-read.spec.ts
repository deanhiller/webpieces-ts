import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
    CODEX_READ_CMD, L0AllowEntry, L0_ALLOWLIST, L0_CODEX_ALLOW_ERE, L0_CODEX_ALLOW_JS, L0_ALLOW_JS,
    L0_CURE_ALLOW_JS, isAllowed,
} from './shim';
import { ShimTestkit } from './shim-testkit';
import { shimStaleRecoveryDecision } from '../adapters/hook-core';
import { detectAiType } from '../adapters/detect-ai';
import { ShellReadParity } from '../core/shell-read-parity';

/**
 * THE CODEX L0 READ DEADLOCK, and the proof it is gone.
 *
 * Under any L0 fault the shim goes default-deny and permits only the allowlist. Entry 1 is "any Read",
 * which is what makes a fault SURVIVABLE for Claude Code: denied all work, the agent still reads the
 * config, the logs and the matrix doc and diagnoses its way out. CODEX HAS NO `Read` TOOL — a read
 * arrives as `Bash` running `sed -n '1,240p' <file>` — so before the aiType-gated entry, a Codex session
 * under D/X/U/K/S was denied EVERYTHING, including the reads the deny was instructing it to perform.
 *
 * This file is the acceptance evidence for the fix, in four parts:
 *   1. the two ENGINES agree (the POSIX ERE the shim greps with, and the JS twin the binary tests);
 *   2. the entry means what `core/shell-read-parity.ts` means — same corpus, same verdicts;
 *   3. CLAUDE CODE CANNOT REACH IT, at both the pattern gate and the harness gate;
 *   4. every L0 FAULT STATE, driven through a real /bin/sh, lets a Codex read through while still
 *      denying a Codex WRITE (`apply_patch`) and a Codex non-read Bash.
 */
const kit = new ShimTestkit();
const parity = new ShellReadParity();

/** Read-shaped commands the entry MUST accept — every spelling a blocked Codex agent would type. */
const READS: readonly string[] = [
    CODEX_READ_CMD,
    "sed -n '1,240p' packages/tooling/ai-hook-rules/src/bin/shim.ts",
    'sed -n 1,50p package.json',
    'cat webpieces.config.json',
    'cat .webpieces/instruct-ai/webpieces.guard-matrix.md',
    'head -50 guards/L0-tooling.md',
    'head -n 50 guards/L0-tooling.md',
    'tail -20 pnpm-workspace.yaml',
    'bat src/index.ts',
    'less README.md',
    'more README.md',
    'cat a.ts b.ts',
    "cat '/Users/dean hiller/repo/package.json'",
];

/**
 * Commands the entry MUST REJECT. Split by WHY, because the two reasons are different properties:
 * the first block is "not a read at all", the second is "a read with something welded onto it", which
 * is the block that keeps this entry from being a general shell escape hatch.
 */
const NOT_READS: readonly string[] = [
    'ls -la',
    'grep -rn turn_id src',
    'rm -rf /',
    'pnpm install',
    'cat',                                   // no operand: that is stdin, not a file read
    'sed -i s/a/b/ package.json',            // an EDIT wearing sed's name
    "sed '1,240p' package.json",             // no -n: sed echoes and edits
    "sed -n 's/a/b/p' package.json",         // a transformation, not a range print
    'cat /etc/passwd; rm -rf /',
    'cat package.json && rm -rf /',
    'cat package.json | sh',
    'cat package.json > /etc/hosts',
    'cat package.json 2>/dev/null',          // a redirect is proof it is more than a read
    'cat package.json | tail -20',           // shell-read-parity says a pipe is not a read
    'cat $(curl evil)',
    'cat `curl evil`',
    'cat $HOME/.ssh/id_rsa',                 // an expansion the pattern refuses to spell
    'cd /x && cat package.json',             // this entry carries NO cd prefix, deliberately
];

describe('the Codex L0 read entry — sh and JS answer identically', () => {
    /**
     * THE UNION IS THE ENTRY, and this is what makes that true.
     *
     * `l0-codex-read.ts` builds the union from its own body constants rather than by filtering
     * `L0_ALLOWLIST` — it cannot filter that array, because the array imports these bodies and the
     * import would be a cycle. So the link is asserted here instead: every gated entry's `ere`/`js` must
     * BE the union's source. Without it, the generated matrix doc could list one pattern while the guard
     * consulted another, which is the exact drift the generated-doc arrangement exists to make
     * impossible.
     */
    it('is built from exactly the bodies the gated allowlist entries carry', () => {
        const gated = L0_ALLOWLIST.filter((e: L0AllowEntry): boolean => e.aiType === 'codex');
        expect(gated.length, 'no gated entry — this whole file would be vacuous').toBe(1);
        const eres = gated.map((e: L0AllowEntry): string => e.ere ?? '');
        const jss = gated.map((e: L0AllowEntry): string => e.js ?? '');
        expect(L0_CODEX_ALLOW_ERE).toBe('^(' + eres.join('|') + ')[[:space:]]*$');
        expect(L0_CODEX_ALLOW_JS.source).toBe('^(' + jss.join('|') + ')\\s*$');
    });

    it('accepts every read spelling on BOTH engines', () => {
        const hits = kit.ereMatchSet(L0_CODEX_ALLOW_ERE, READS);
        for (const cmd of READS) {
            expect(L0_CODEX_ALLOW_JS.test(cmd), `JS rejected a read: ${cmd}`).toBe(true);
            expect(hits.matched(cmd), `the shim's grep -E rejected a read: ${cmd}`).toBe(true);
        }
    });

    it('rejects every non-read on BOTH engines', () => {
        const hits = kit.ereMatchSet(L0_CODEX_ALLOW_ERE, NOT_READS);
        for (const cmd of NOT_READS) {
            expect(L0_CODEX_ALLOW_JS.test(cmd), `JS accepted a non-read: ${cmd}`).toBe(false);
            expect(hits.matched(cmd), `the shim's grep -E accepted a non-read: ${cmd}`).toBe(false);
        }
    });
});

/**
 * AS WIDE AS core/shell-read-parity.ts AND NO WIDER — asserted over the same corpus rather than argued.
 *
 * The two cannot be ONE function: L0's sh half has no JS at all, and its JS half runs where nothing
 * above it can be trusted. So they share the VOCABULARY (READ_COMMANDS, SED_RANGE_BODY) and this test
 * is the lock on the rest. The ONE dimension in which they legitimately differ is the filesystem: the
 * predicate resolves every operand and rejects anything outside the tree, and a regex cannot ask. That
 * is not a privilege boundary at L0 — allowlist entry 1 grants an unrestricted Read of any path already
 * — so the corpus below stages real in-tree files and asserts exact agreement on everything else.
 */
describe('the entry agrees with the shell-read predicate over a corpus', () => {
    it('classifies every corpus command the same way the read predicate does', () => {
        const root = fs.realpathSync(kit.mktmp());
        for (const name of ['a.ts', 'b.ts', 'package.json', 'README.md', 'webpieces.config.json']) {
            fs.writeFileSync(path.join(root, name), 'x\n');
        }
        fs.mkdirSync(path.join(root, 'src'), { recursive: true });
        fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'x\n');
        // Only the commands whose operands exist HERE can be compared — the others differ in exactly the
        // filesystem dimension the docblock above carves out, and comparing them would assert the
        // opposite of what it says.
        const comparable: readonly string[] = [
            'cat package.json', 'cat a.ts b.ts', 'head -50 README.md', 'head -n 50 README.md',
            'tail -20 package.json', 'bat src/index.ts', "sed -n '1,240p' package.json",
            'sed -n 1,50p package.json', ...NOT_READS,
        ];
        for (const cmd of comparable) {
            const isReadByPredicate = parity.readTargets(cmd, root, root).length > 0;
            expect(L0_CODEX_ALLOW_JS.test(cmd), `L0 and shell-read-parity disagree on: ${cmd}`)
                .toBe(isReadByPredicate);
        }
    });
});

/**
 * CLAUDE CODE MUST NOT BE ABLE TO REACH THIS ENTRY — the hard constraint of the change, asserted at
 * both gates independently, because either one alone would be a single point of failure.
 */
describe('the Codex read entry is unreachable from Claude Code', () => {
    it('is absent from the ungated union, so no Claude payload can match it by pattern', () => {
        for (const cmd of READS) {
            expect(L0_ALLOW_JS.test(cmd), `leaked into the ungated L0 union: ${cmd}`).toBe(false);
            expect(L0_CURE_ALLOW_JS.test(cmd), `leaked into the CURE union (bypasses L1): ${cmd}`).toBe(false);
        }
    });

    it('answers null for every read spelling when the harness is claude-code', () => {
        for (const cmd of READS) {
            expect(isAllowed('Bash', cmd, '', 'claude-code'), `reachable from claude-code: ${cmd}`).toBeNull();
            expect(isAllowed('Bash', cmd, '', 'codex'), `denied to codex: ${cmd}`).toBe('pass');
        }
    });

    it('keeps a Claude Bash call that MENTIONS the discriminator on the claude-code path', () => {
        // The load-bearing fact, and the reason this is not merely likely: JSON escapes every `"` inside
        // a string value, so a command carrying the token reaches the wire as \\"turn_id\\": and the raw
        // payload contains no `"turn_id":` at all. There is no spelling of a shell command that puts the
        // token in unescaped.
        const payload = JSON.stringify({
            hook_event_name: 'PreToolUse', tool_name: 'Bash',
            tool_input: { command: `grep -rn '"turn_id":' src` }, cwd: '/repo', session_id: 's1',
        });
        expect(payload.includes('"turn_id":')).toBe(false);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        expect(detectAiType(JSON.parse(payload))).toBe('claude-code');
    });

    /**
     * THE RESIDUAL GAP, pinned as a characterization test rather than left in prose.
     *
     * A NESTED `turn_id` key — an MCP tool_input that happens to carry one — is answered `codex` by the
     * sh approximation and `claude-code` by the precise JS test. sh has no JSON parser and cannot close
     * that; what makes it TOLERABLE is the bound asserted here: the only thing the harness answer gates
     * is a read, and allowlist entry 1 grants Claude Code an unrestricted Read of any path under every
     * L0 fault already. So a misclassification hands a Claude session another SPELLING of a capability
     * it already had — never a new one. Anything added to the gated set later must keep that true.
     */
    it('bounds the residual misclassification to a capability claude-code already has', () => {
        // Whatever the gated union admits is a READ and nothing else — the property that makes the sh
        // approximation safe. A write, a delete and an install all stay outside it.
        for (const cmd of ['rm -rf /', 'pnpm install', 'git push', 'echo x > package.json']) {
            expect(L0_CODEX_ALLOW_JS.test(cmd), `the gated union is not read-only: ${cmd}`).toBe(false);
        }
        // …and entry 1 already grants claude-code exactly that capability, with no path restriction.
        expect(isAllowed('Read', '', '/etc/passwd', 'claude-code')).toBe('pass');
    });
});

/**
 * THE ACCEPTANCE TEST — every L0 fault state, driven through a REAL /bin/sh, exactly as Claude Code and
 * Codex drive the committed shim.
 *
 * A Codex payload carries `turn_id`; that is the whole discriminator (adapters/detect-ai.ts). Each fault
 * is staged the way `shim-testkit` stages it, and each asserts the same three things: the read gets
 * through, the WRITE does not, and a non-read Bash does not. Without this, the fix is a pattern nobody
 * has watched decide anything.
 */
describe('every L0 fault: a Codex READ is allowed, a Codex WRITE and a non-read Bash are not', () => {
    /**
     * A Codex PreToolUse payload — `turn_id` is the one key that makes it Codex.
     *
     * `cwd` selects WHERE the audit line is written (RESOLVE_LOG_DIR_SH) and nothing about the verdict,
     * so it defaults to a placeholder and is passed the staged root only by the test that reads the log.
     */
    function codexPayload(toolName: string, command: string, cwd: string = '/repo'): string {
        return JSON.stringify({
            hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: { command },
            cwd, session_id: 's1', turn_id: 'turn-1',
        });
    }

    /** Fault K — the bin is installed and CRASHES (corrupt node_modules), so no drift and no absence. */
    function stageCrashedBin(): string {
        const root = kit.stageDriftRoot('1.0.0', '1.0.0');
        fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'wp-ai-guards-hook'),
            '#!/bin/sh\nprintf "Cannot find module x" >&2\nexit 1\n', { mode: 0o755 });
        // The pin above is @webpieces/pr-gate; declaring ai-hook-rules too keeps this K and not U.
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
            dependencies: { '@webpieces/pr-gate': '1.0.0' },
            devDependencies: { '@webpieces/ai-hook-rules': '1.0.0' },
        }, null, 2) + '\n');
        return root;
    }

    const FAULTS: ReadonlyArray<readonly [string, () => string]> = [
        ['D (version drift)', (): string => kit.stageDriftRoot('0.4.700', '0.4.600')],
        ['X (bin missing, package declared)', (): string => kit.stageDeclaredRoot()],
        ['U (bin missing, package undeclared)', (): string => kit.mktmp()],
        ['K (bin present but crashed)', stageCrashedBin],
    ];

    it.each(FAULTS)('fault %s lets a Codex read through', (_name: string, stage: () => string) => {
        const root = stage();
        const read = kit.runShim(root, 'wp-ai-guards-hook', codexPayload('Bash', CODEX_READ_CMD));
        expect(read.isDenied(), `the read was DENIED — the deadlock is back: ${read.stdout}`).toBe(false);
    });

    it.each(FAULTS)('fault %s still denies a Codex apply_patch and a non-read Bash', (_name: string, stage: () => string) => {
        const root = stage();
        const write = kit.runShim(root, 'wp-ai-guards-hook',
            codexPayload('apply_patch', '*** Begin Patch\n*** Add File: x.txt\n+x\n*** End Patch'));
        expect(write.isDenied(), 'a Codex WRITE was allowed through an L0 fault').toBe(true);

        const bash = kit.runShim(root, 'wp-ai-guards-hook', codexPayload('Bash', 'rm -rf /'));
        expect(bash.isDenied(), 'a non-read Codex Bash was allowed through an L0 fault').toBe(true);
    });

    it.each(FAULTS)('fault %s denies the SAME read command when the harness is Claude Code', (_name: string, stage: () => string) => {
        const root = stage();
        // The regression assertion for the hard constraint: identical bytes, no turn_id, still denied.
        const claude = kit.runShim(root, 'wp-ai-guards-hook', kit.bashPayload(CODEX_READ_CMD));
        expect(claude.isDenied(), 'Claude Code reached the Codex-gated entry').toBe(true);
    });

    /**
     * Fault S is decided in the BINARY, not in sh — a stale committed shim is a JS verdict — so it is
     * driven through the same predicate `enforceCommittedShim` calls, with the raw wire fields it uses.
     */
    it('fault S (stale committed shim) allows the read and denies the write', () => {
        expect(shimStaleRecoveryDecision('Bash', CODEX_READ_CMD, '', 'codex')).toBe('pass');
        expect(shimStaleRecoveryDecision('Bash', CODEX_READ_CMD, '', 'claude-code')).toBe('deny');
        expect(shimStaleRecoveryDecision('apply_patch', '*** Begin Patch\n*** End Patch', '', 'codex')).toBe('deny');
        expect(shimStaleRecoveryDecision('Bash', 'rm -rf /', '', 'codex')).toBe('deny');
    });

    /**
     * The audit trail has to be able to SHOW this, or the matrix doc describes a verdict nobody can find
     * in a log. `ALLOW-CODEX-READ` is the label, and its presence on a `ai=claude-code` line would be the
     * signal that the sh approximation misread a payload.
     */
    it('records the ALLOW-CODEX-READ verdict with the harness on the same line', () => {
        const root = kit.stageDeclaredRoot();
        kit.runShim(root, 'wp-ai-guards-hook', codexPayload('Bash', CODEX_READ_CMD, root));
        const dir = path.join(root, '.webpieces', 'logs', 'L0-shim');
        const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
        expect(files.length, 'the shim wrote no audit line at all').toBeGreaterThan(0);
        const body = files.map((f: string): string => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
        expect(body).toContain('ALLOW-CODEX-READ');
        expect(body).toContain('ai=codex');
    });
});
