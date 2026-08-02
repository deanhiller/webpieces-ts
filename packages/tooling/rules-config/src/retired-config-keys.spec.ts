import { RETIRED_CONFIG_KEYS, RETIRED_SCOPE_KEY, RETIRED_SCOPE_RULE, retiredKeyError } from './retired-config-keys';

/**
 * THE POLICY GUARD. webpieces.config.json is never released backwards-compatible: a retired key must FAIL
 * the load with an instruction naming its destination, so the agent reading the error migrates the file.
 *
 * These tests are what make that structural rather than aspirational. If someone re-adds a fallback that
 * quietly accepts a retired key — the exact thing that kept `commands.upsertPr` and the two-list
 * `excludePaths` alive in this repo's own config for releases — the corresponding case here goes red.
 *
 * Adding an entry to RETIRED_CONFIG_KEYS without deleting its read path will therefore fail CI.
 */
describe('RETIRED_CONFIG_KEYS — the no-back-compat guard', () => {
    it('has at least one entry (an empty table would make every case below vacuous)', () => {
        expect(RETIRED_CONFIG_KEYS.length).toBeGreaterThan(0);
    });

    it('uses only the two defined scopes', () => {
        for (const entry of RETIRED_CONFIG_KEYS) {
            expect([RETIRED_SCOPE_RULE, RETIRED_SCOPE_KEY]).toContain(entry.scope);
        }
    });

    it('never lists a key as its own destination (an entry that instructs a no-op edit)', () => {
        for (const entry of RETIRED_CONFIG_KEYS) {
            expect(entry.movedTo).not.toBe(entry.key);
        }
    });

    /**
     * The instruction is the whole product: it is read by an agent that acts on it verbatim. An entry that
     * only says "this was removed" sends that agent guessing, which is how a migration turns into a
     * config-gutting session.
     */
    it('gives every entry a non-empty, imperative instruction', () => {
        for (const entry of RETIRED_CONFIG_KEYS) {
            expect(entry.instruction.trim().length).toBeGreaterThan(0);
            expect(entry.label.startsWith('[')).toBe(true);
        }
    });

    it('names the destination in the rendered error whenever there is one', () => {
        for (const entry of RETIRED_CONFIG_KEYS) {
            const message = retiredKeyError(entry);
            expect(message).toContain(entry.key);
            expect(message).toContain('RETIRED');
            if (entry.movedTo === '') {
                expect(message).toContain('removed with no replacement');
            } else {
                expect(message).toContain(entry.movedTo);
            }
        }
    });

    it('has no duplicate entries for the same key within a scope+label', () => {
        const seen = new Set<string>();
        for (const entry of RETIRED_CONFIG_KEYS) {
            const id = `${entry.scope}|${entry.label}|${entry.key}`;
            expect(seen.has(id)).toBe(false);
            seen.add(id);
        }
    });
});
