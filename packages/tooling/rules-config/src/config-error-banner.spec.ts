import { describe, it, expect } from 'vitest';

import {
    formatConfigErrorsBanner,
    migratorCoveredCount,
    RETIRED_KEY_MARKER,
    RETIRED_TOP_LEVEL_MARKER,
    SECTION_PLACEMENT_MARKER,
} from './config-error-banner';
import { validateCommandsSection } from './commands-section-validators';
import { RETIRED_CONFIG_KEYS, RetiredConfigKey, retiredKeyError } from './retired-config-keys';
import { validateSectionPlacement } from './validate-config';

/**
 * THE INVARIANT this banner exists to state: every error it carries came from validating ONE file, so
 * the cure is always "edit that file". The banner it replaced printed a fixed four-step FIX ORDER whose
 * first step (`pnpm install`) could not help — the guard bin only runs when package.json and
 * node_modules already agree — and whose later steps were filler and a competing command.
 */
describe('config-error banner — one cure, stated once', () => {
    const banner = formatConfigErrorsBanner(['[some-rule] Unknown rule — no schema for it.']);

    it('tells the reader to edit webpieces.config.json, and that editing it is always allowed', () => {
        expect(banner).toContain('edit webpieces.config.json');
        expect(banner).toContain('ALWAYS allowed');
    });

    it('does NOT recommend `pnpm install` — it names it only to rule it out', () => {
        expect(banner).toContain('Do NOT run `pnpm install`');
        // The ONLY occurrence is inside that negative instruction. A second one would be a step again.
        expect(banner.split('`pnpm install`')).toHaveLength(2);
    });

    it('keeps the anti-destructive warning, re-aimed at the PIN rather than at node_modules', () => {
        expect(banner).toContain('Do NOT delete a key just because it is reported unknown');
        expect(banner).toContain('package.json pins an @webpieces OLDER');
    });

    it('never emits a retry step at all, and prints no ordered FIX list', () => {
        expect(banner).not.toContain('Retry your command');
        expect(banner).not.toContain('then retry');
        expect(banner).not.toContain('FIX ORDER');
    });

    // "There is no other step" is the load-bearing clause: without it the reader treats the two DO-NOTs
    // as a list they are still expected to work through.
    it('says outright that there is no step beyond the edit', () => {
        expect(banner).toContain('There is no other step');
    });

    it('counts the errors and prints each as a bullet', () => {
        const two = formatConfigErrorsBanner(['first error', 'second error']);
        expect(two).toContain('has 2 validation error(s)');
        expect(two).toContain('  • first error');
        expect(two).toContain('  • second error');
    });
});

/**
 * The ONE conditional line. `--sync` is not a different cure, it is a bulk editor — so it is offered
 * only for the errors migrate() actually performs, and never for a config whose errors it cannot touch
 * (advertising it there is exactly how the old step 4 misled).
 */
describe('config-error banner — the optional bulk editor', () => {
    it('is omitted entirely when no error is one the migrator covers', () => {
        const banner = formatConfigErrorsBanner(['[some-rule] Unknown field "x". Valid fields: [mode].']);
        expect(banner).not.toContain('--sync');
        expect(banner).not.toContain('OPTIONAL');
    });

    // For ONE key the bullet already names a one-line edit, and `--sync` would rewrite the whole file
    // to make it. The bulk editor is a sweep tool, so it stays silent below the threshold.
    it('is omitted for a SINGLE retired key', () => {
        const banner = formatConfigErrorsBanner([retiredKeyError(RETIRED_CONFIG_KEYS[0])]);
        expect(banner).not.toContain('--sync');
    });

    it('is offered — with its whole-file cost, and never as the bare bin — on a sweep of retired keys', () => {
        const retired = retiredKeyError(RETIRED_CONFIG_KEYS[0]);
        const banner = formatConfigErrorsBanner([retired, retiredKeyError(RETIRED_CONFIG_KEYS[1])]);
        expect(banner).toContain('`pnpm wp-install-ai-hooks --sync`');
        expect(banner).toContain('rewrites the WHOLE');
        expect(banner).toContain('PROMPTS for a target');
        // Still the same single cure: the edit instruction leads, the bulk option follows.
        expect(banner.indexOf('THE FIX')).toBeLessThan(banner.indexOf('--sync'));
    });

    it('counts only the covered errors', () => {
        const retired = retiredKeyError(RETIRED_CONFIG_KEYS[0]);
        expect(migratorCoveredCount([retired, 'unrelated error'])).toBe(1);
        expect(migratorCoveredCount(['unrelated error'])).toBe(0);
    });
});

/**
 * ANTI-DRIFT. The markers are imported by the message builders rather than re-typed, but that only
 * proves the string is shared — not that the builder still EMITS it. So drive REAL validator output
 * through the counter: if a message is reworded away from its marker, these go red.
 */
describe('config-error banner — the migrator markers match what the validators actually emit', () => {
    it('recognizes every RETIRED_CONFIG_KEYS message', () => {
        for (const entry of RETIRED_CONFIG_KEYS) {
            const message = retiredKeyError(entry);
            expect(message, `entry ${entry.key}`).toContain(RETIRED_KEY_MARKER);
            expect(migratorCoveredCount([message]), `entry ${entry.key}`).toBe(1);
        }
    });

    it('recognizes a guard left in `rules` and a code rule left in `hookGuards`', () => {
        const guardInRules = validateSectionPlacement({ 'pr-merge-guard': {} }, {});
        const ruleInGuards = validateSectionPlacement({}, { 'max-file-lines': {} });
        expect(guardInRules).toHaveLength(1);
        expect(ruleInGuards).toHaveLength(1);
        for (const message of [...guardInRules, ...ruleInGuards]) {
            expect(message).toContain(SECTION_PLACEMENT_MARKER);
            expect(migratorCoveredCount([message])).toBe(1);
        }
    });

    it('recognizes the retired TOP-LEVEL pr-gate block', () => {
        const errors = validateCommandsSection(undefined, { mode: 'OFF' });
        const topLevel = errors.filter((e: string): boolean => e.includes(RETIRED_TOP_LEVEL_MARKER));
        expect(topLevel).toHaveLength(1);
        expect(migratorCoveredCount(topLevel)).toBe(1);
    });

    it('does not claim to cover an error the migrator cannot perform', () => {
        // A malformed gate is a hand-edit: migrate() never touches the contents of pr-gate.gates.
        expect(migratorCoveredCount(['[pr-gate] gates[0].name must be a string.'])).toBe(0);
    });

    // The retired table is the migrator's own worklist; a scope it stops covering must be caught here.
    it('every retired entry carries a destination the banner can point at', () => {
        for (const entry of RETIRED_CONFIG_KEYS) {
            const typed: RetiredConfigKey = entry;
            expect(typed.instruction.length, `entry ${typed.key}`).toBeGreaterThan(0);
        }
    });
});
