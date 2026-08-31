import { describe, it, expect } from 'vitest';

import * as fs from 'fs';
import * as path from 'path';

import { isAllowed, L0_IGNORED_TOOLS, L0_IGNORED_TOOLS_SH, renderShim } from './shim';
import { ShimTestkit } from './shim-testkit';
import { L0_SHIM_STREAM } from '../core/log-streams';

/**
 * THE sh ↔ JS TWIN LOCK for the tools L0 has nothing to judge.
 *
 * L0 has two enforcement points that must answer the identical question: the rendered POSIX-sh shim,
 * which decides D/X/U/K before the guard bin runs, and `isAllowed(, 'claude-code')` in this binary, which decides S/C/Y
 * after it. A disagreement is invisible — one half allows, the other denies, and which one you meet
 * depends on which fault happens to be up. So the two are driven over one corpus here, the sh half
 * through a REAL /bin/sh rather than a re-implementation (a re-implementation is a third answer, and a
 * third answer is a third thing that can drift).
 *
 * The corpus is `L0_IGNORED_TOOLS` itself plus the one tool that must NOT be on it, so adding a tool to
 * the set extends the test with it and cannot be done in only one of the two halves.
 */
const kit = new ShimTestkit();

/** What the sh half did with one call. Data-only → a class, per CLAUDE.md. */
class ShimVerdict {
    constructor(readonly denied: boolean, readonly log: string) {}
}

/** The one L0 shim log this tree wrote — locating it also proves exactly one writer was used. */
function readShimLog(root: string): string {
    const dir = path.join(root, '.webpieces', 'logs', L0_SHIM_STREAM);
    const hits = fs.readdirSync(dir).filter((n: string): boolean => n.endsWith('.log') && !n.endsWith('.1.log'));
    if (hits.length !== 1) throw new Error(`expected 1 shim log, found ${hits.length}: ${hits.join()}`);
    return fs.readFileSync(path.join(dir, hits[0]), 'utf8');
}

/** A Codex payload (turn_id present) naming one tool, run through the shim under a real fault. */
function shimVerdict(toolName: string, toolInput: Record<string, string>): ShimVerdict {
    // stageDeclaredRoot(): package.json declares the guard package, nothing is installed → fault X.
    const root = kit.stageDeclaredRoot();
    const out = kit.runShim(root, 'wp-ai-guards-hook', JSON.stringify({
        tool_name: toolName, cwd: root, tool_input: toolInput, turn_id: 't1',
    }));
    return new ShimVerdict(out.isDenied(), readShimLog(root));
}

describe('the ignored-tool twins agree, tool by tool', () => {
    it.each([...L0_IGNORED_TOOLS])('%s: both halves PASS it while the guards are down', (toolName: string) => {
        expect(isAllowed(toolName, '', '', 'claude-code')).toBe('pass');
        const verdict = shimVerdict(toolName, {});
        expect(verdict.denied, `${toolName} was DENIED by the sh half`).toBe(false);
        expect(verdict.log).toContain('ALLOW-IGNORED');
    });

    /**
     * `apply_patch` is Codex's ONLY write, and its absence from the set is the whole safety property.
     * If it ever joins — by a widened pattern, or by someone reading "ignore what we cannot judge" as
     * "ignore what we do not recognise" — every Codex file edit sails past every L0 fault.
     */
    it('apply_patch is NOT ignored: both halves fail closed on it', () => {
        expect(L0_IGNORED_TOOLS.has('apply_patch')).toBe(false);
        expect(isAllowed('apply_patch', '*** Begin Patch\n*** Add File: a.ts\n+a\n*** End Patch', '', 'claude-code')).toBeNull();
        const verdict = shimVerdict('apply_patch', { command: '*** Begin Patch\\n*** Add File: a.ts\\n+a\\n*** End Patch' });
        expect(verdict.denied).toBe(true);
        expect(verdict.log).toContain('\tDENY\t');
    });

    /**
     * The default is DENY, not "ignore". The adapter's default for an unknown tool is safe because a
     * healthy tree still has every guard behind it; L0's default cannot be, or a future write-capable
     * Codex tool is waved past every fault on the day it ships.
     */
    it('an unrecognised tool is NOT ignored — L0 fails closed on what it has never seen', () => {
        expect(isAllowed('some_future_codex_tool', 'rm -rf /', '', 'claude-code')).toBeNull();
        expect(shimVerdict('some_future_codex_tool', { command: 'rm -rf /' }).denied).toBe(true);
    });
});

describe('the sh alternation is BUILT from the set, never retyped', () => {
    it('renders exactly the set into the shim, in one case pattern', () => {
        expect(L0_IGNORED_TOOLS_SH.split('|').sort()).toEqual([...L0_IGNORED_TOOLS].sort());
        expect(renderShim()).toContain(L0_IGNORED_TOOLS_SH);
    });
});
