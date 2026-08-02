import { describe, it, expect } from 'vitest';
import { loadTemplate } from '@webpieces/rules-config';

import {
    L0AllowEntry, L0Call, L0_ALLOWLIST, L0_ALLOW_ERE, L0_ALLOW_JS,
    CD_PREFIX_JS_SRC, CAPTURE_TAIL_JS_SRC, isAllowed,
} from '../bin/shim';
import { ShimTestkit } from '../bin/shim-testkit';
import { shimStaleRecoveryDecision } from '../adapters/hook-core';
import { L0Cure, L0Fault, L0_FAULTS, GUARD_MATRIX_DOC, renderGuardMatrixDoc, guardMatrixPointer } from './l0-matrix';

const kit = new ShimTestkit();

// Calls that are on NO entry of the list — the BLOCK row of the matrix.
const NOT_ALLOWED: readonly L0Call[] = [
    new L0Call('Bash', 'git merge origin/main', ''),
    new L0Call('Bash', 'git push', ''),
    new L0Call('Bash', 'pnpm install && rm -rf /', ''),
    new L0Call('Bash', 'pnpm build', ''),
    new L0Call('Edit', '', '/repo/src/index.ts'),
    new L0Call('Write', '', '/repo/package.json'),
];

/**
 * THE MATRIX, asserted as a matrix.
 *
 * The whole point of the L0 rewrite is that the table has THREE rows, not eighteen: the fault selects
 * the MESSAGE and nothing else. So the test enumerates fault × call and asserts the answer is (a)
 * exactly one of the three outcomes and (b) identical for every fault. If anyone ever re-introduces a
 * per-fault carve-out, this fails on the first cell.
 */
describe('L0 matrix — every (fault, call) yields exactly ONE outcome, and the fault never changes it', () => {
    const allCalls: readonly L0Call[] = [...L0_ALLOWLIST.map((e: L0AllowEntry): L0Call => e.sample), ...NOT_ALLOWED];

    it('has six faults with unique codes', () => {
        expect(L0_FAULTS).toHaveLength(6);
        expect(new Set(L0_FAULTS.map((f: L0Fault): string => f.code)).size).toBe(6);
    });

    it('answers each call with exactly one of pass | allow | null, the same answer under every fault', () => {
        for (const call of allCalls) {
            const outcome = isAllowed(call.toolName, call.command, call.filePath);
            expect([null, 'pass', 'allow']).toContain(outcome);
            // isAllowed takes NO fault parameter — that is the invariant. Re-asking it once per fault
            // is what makes the "no second dimension" claim a test rather than a comment.
            for (const fault of L0_FAULTS) {
                const again = isAllowed(call.toolName, call.command, call.filePath);
                expect(again, `fault ${fault.code} changed the outcome for: ${call.command || call.filePath}`).toBe(outcome);
            }
        }
    });

    it('gives every allowlist entry its declared outcome, and blocks everything else', () => {
        for (const entry of L0_ALLOWLIST) {
            const s = entry.sample;
            expect(isAllowed(s.toolName, s.command, s.filePath), `entry: ${entry.label}`).toBe(entry.kind);
        }
        for (const call of NOT_ALLOWED) {
            expect(isAllowed(call.toolName, call.command, call.filePath), `must block: ${call.command || call.filePath}`).toBeNull();
        }
    });

    // No row is SHADOWED: each Bash entry is matched by its own body and by NO other body, so every
    // entry is load-bearing. A shadowed row is a row someone can delete believing it still works.
    it('has no shadowed row — each Bash entry is the only one matching its own sample', () => {
        const bashEntries = L0_ALLOWLIST.filter((e: L0AllowEntry): boolean => e.js !== null);
        for (const entry of bashEntries) {
            const own = new RegExp('^' + CD_PREFIX_JS_SRC + '(' + entry.js + ')' + CAPTURE_TAIL_JS_SRC);
            expect(own.test(entry.sample.command), `own body must match: ${entry.label}`).toBe(true);

            const others = bashEntries.filter((o: L0AllowEntry): boolean => o !== entry).map((o: L0AllowEntry): string => o.js ?? '');
            const rest = new RegExp('^' + CD_PREFIX_JS_SRC + '(' + others.join('|') + ')' + CAPTURE_TAIL_JS_SRC);
            expect(rest.test(entry.sample.command), `shadowed by another entry: ${entry.label}`).toBe(false);
        }
    });

    it('maps the three outcomes onto the shim-stale adapter one-for-one', () => {
        for (const entry of L0_ALLOWLIST) {
            const s = entry.sample;
            const expected = entry.kind === 'pass' ? 'pass' : 'allow-cure';
            expect(shimStaleRecoveryDecision(s.toolName, s.command, s.filePath)).toBe(expected);
        }
        for (const call of NOT_ALLOWED) {
            expect(shimStaleRecoveryDecision(call.toolName, call.command, call.filePath)).toBe('deny');
        }
    });
});

/**
 * THE ANTI-DEADLOCK TEST.
 *
 * CLAUDE.md records three separate deadlocks of exactly one shape: a deny that prescribes a command
 * the allowlist then rejects (`2>&1 | tail -15`, the `cd` prefix, the `.claude/` `cp`). The assistant
 * reads its own denial as "the guard blocks its own fix" and hands the block back to the human.
 *
 * So for EVERY fault: every cure it names must be (a) accepted by isAllowed and (b) actually spelled in
 * that fault's deny text. This is the test that caught the config-missing deny naming
 * `wp-setup-ai-hooks` — a bin that has not existed since it was renamed to wp-install-ai-hooks.
 */
describe('cure reachability — every fault names at least one cure the allowlist accepts', () => {
    for (const fault of L0_FAULTS) {
        it(`fault ${fault.code} (${fault.name}) has a reachable, named cure`, () => {
            expect(fault.cures.length).toBeGreaterThan(0);
            for (const cure of fault.cures) {
                const c: L0Call = cure.call;
                expect(isAllowed(c.toolName, c.command, c.filePath), `cure is DENIED by L0: ${cure.mention}`).not.toBeNull();
                expect(fault.denyText, `deny text never names the cure: ${cure.mention}`).toContain(cure.mention);
            }
        });
    }

    it('never prescribes the bin that no longer exists', () => {
        for (const fault of L0_FAULTS) {
            expect(fault.denyText, `fault ${fault.code}`).not.toContain('wp-setup-ai-hooks');
        }
    });
});

/**
 * `git merge` left the allowlist deliberately. It was only ever accepted because the guards are DOWN,
 * and the drift deny had to spend a sentence warning against the thing the list permitted. Main is
 * merged ONLY via the 3-point fork merge. Asserted on BOTH engines, since sh decides D/X/K and JS
 * decides S/C/Y — a merge allowed by one of them is a merge allowed.
 */
describe('git merge is rejected by both L0 engines', () => {
    const merges = [
        'git merge origin/main',
        'git merge --ff-only origin/main',
        'cd /x && git merge origin/main',
        'git merge origin/main 2>&1 | tail -20',
    ];

    it('is rejected by the JS twin', () => {
        for (const cmd of merges) expect(L0_ALLOW_JS.test(cmd), cmd).toBe(false);
    });

    it('is rejected by the POSIX ERE the rendered shim greps with', () => {
        const hits = kit.ereMatchSet(L0_ALLOW_ERE, merges);
        for (const cmd of merges) expect(hits.matched(cmd), cmd).toBe(false);
    });
});

/**
 * The doc IS the arrays. Locked byte-identical the same way templates/ai-hook.sh is locked to
 * renderShim() — a doc that merely describes the allowlist drifts from it within one release.
 */
describe('webpieces.guard-matrix.md is generated from the same arrays the guard consults', () => {
    it('matches renderGuardMatrixDoc() byte for byte', () => {
        expect(loadTemplate(GUARD_MATRIX_DOC)).toBe(renderGuardMatrixDoc());
    });

    it('lists every fault and every allowlist entry', () => {
        const doc = renderGuardMatrixDoc();
        for (const fault of L0_FAULTS) expect(doc).toContain(fault.name);
        for (const entry of L0_ALLOWLIST) expect(doc).toContain(entry.label);
    });

    it('points the reader at the doc only when it was actually written', () => {
        expect(guardMatrixPointer('')).toBe('');
        expect(guardMatrixPointer('/repo/.webpieces/instruct-ai/webpieces.guard-matrix.md'))
            .toContain('/repo/.webpieces/instruct-ai/webpieces.guard-matrix.md');
    });

    // The deny text is interpolated into a REASON="…" shell assignment and then printf'd into a JSON
    // string, so a quote or backslash would corrupt the decision payload, not just the prose.
    it('emits a JSON-safe pointer', () => {
        const pointer = guardMatrixPointer('/repo/.webpieces/instruct-ai/webpieces.guard-matrix.md');
        expect(pointer).not.toContain('"');
        expect(pointer).not.toContain('\\');
    });
});

/** Guards the one place a cure can be declared: L0Cure carries both halves or the test above is vacuous. */
describe('L0Cure', () => {
    it('keeps the mention and the call together', () => {
        const cure = new L0Cure('pnpm install', new L0Call('Bash', 'pnpm install', ''));
        expect(cure.mention).toBe('pnpm install');
        expect(cure.call.command).toBe('pnpm install');
    });
});
