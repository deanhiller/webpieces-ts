import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { EVERY_HARNESS, L0AllowEntry, L0_ALLOWLIST } from './shim';
import { AI_TYPES, AiType } from '../core/agent-event';

/**
 * "EVERY HARNESS" IS A TOKEN, NOT AN ABSENCE — and this file is what keeps it that way.
 *
 * `L0AllowEntry.harness` used to be `AiType | null`, where `null` meant "applies to every harness".
 * That is shim shape #5 from CLAUDE.md: a widening expressed as an ABSENCE. Two things were wrong
 * with it and only one of them was cosmetic:
 *
 *   1. UNGREPPABLE. There is no search that lists the widest entries, because they were identified
 *      by a field that was not there. `grep -n EVERY_HARNESS src/bin/l0-allowlist.ts` now names all
 *      of them, which is the property the whole change exists to buy.
 *   2. SHORTEST TO TYPE. `null` is what you write when you have not thought about the question. The
 *      most permissive setting must never be the path of least resistance on a DEFAULT-DENY list.
 *
 * Dean's rule, which is the type: **we only support codex or claudecode or FAIL**. So the assertions
 * below are about the SOURCE as much as the values — a future default, an optional marker or a
 * re-introduced `null` would all restore "wide by omission" while every runtime value still looked
 * correct, and only reading the text catches that.
 */
describe('the L0 allowlist names its harness — always, and out loud', () => {
    const SRC = path.join(__dirname, 'l0-allowlist.ts');
    const source = fs.readFileSync(SRC, 'utf8');

    /** Every value the field may hold. There is no fourth, and no absence. */
    const LEGAL: readonly string[] = [EVERY_HARNESS, ...AI_TYPES];

    it('gives every entry one of exactly three named harness values', () => {
        expect(L0_ALLOWLIST.length, 'this test is vacuous with an empty list').toBeGreaterThan(0);
        for (const e of L0_ALLOWLIST) {
            expect(LEGAL, `entry has no named harness: ${e.label}`).toContain(e.harness);
        }
    });

    /**
     * The point of the token, stated as an assertion: the wide entries are FINDABLE. If this ever
     * fails it is because somebody found a way to be wide without saying so.
     */
    it('makes every wide entry greppable by the token itself', () => {
        const wide = L0_ALLOWLIST.filter((e: L0AllowEntry): boolean => e.harness === EVERY_HARNESS);
        expect(wide.length, 'no wide entry — this test is vacuous').toBeGreaterThan(0);

        // The identifier, not its string value — `grep -n EVERY_HARNESS` is the search a human runs,
        // and every wide entry must be one of its hits.
        const mentions = (source.match(/\bEVERY_HARNESS\b/g) ?? []).length;
        expect(mentions, `${wide.length} wide entries but only ${mentions} mentions of the token`)
            .toBeGreaterThanOrEqual(wide.length);
    });

    /**
     * THE OMISSION CHECK. A constructor default, an optional marker, or `| null` back on the type
     * would each let a new entry be wide without writing anything — which is the exact defect this
     * replaced. None of them can be caught by inspecting values, so the source is read instead.
     */
    it('offers no way to be wide by omission — no default, no optional, no null', () => {
        // Exactly ONE declaration of the field, and it is the bare required form. A default value
        // (`= EVERY_HARNESS`), an optional marker (`harness?:`) or a widened type (`| null`) would
        // each show up here as different bytes, so this one equality closes all three at once.
        const decls = source.match(/^\s*readonly harness[^\n]*$/gm) ?? [];
        expect(decls.length, 'the harness field declaration moved or multiplied').toBe(1);
        expect(decls[0].trim()).toBe('readonly harness: L0Harness,');

        // The type it points at must not itself readmit an absence.
        const alias = source.match(/^export type L0Harness = [^\n]*$/m);
        expect(alias, 'the L0Harness alias moved — re-point this test').not.toBeNull();
        expect(alias?.[0]).toBe(`export type L0Harness = AiType | typeof EVERY_HARNESS;`);
    });

    /**
     * The union has no third member beyond the harnesses plus the token — so a typo like
     * `'claude'` (the value the audit reader must NOT expect; the real one is `claude-code`)
     * cannot slip in as a silently-unreachable gate.
     */
    it('gates only on harnesses that actually exist', () => {
        const gated = L0_ALLOWLIST
            .filter((e: L0AllowEntry): boolean => e.harness !== EVERY_HARNESS)
            .map((e: L0AllowEntry): string => e.harness);
        for (const h of gated) expect(AI_TYPES).toContain(h as AiType);
    });
});
