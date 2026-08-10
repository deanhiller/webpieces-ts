import { describe, it, expect } from 'vitest';

import {
    formatConfigErrorsBanner,
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

    /**
     * THE ADVICE USED TO BE INVERTED. This assertion previously demanded the opposite string — "Do NOT
     * delete a key just because it is reported unknown" — on an anti-destructive theory that turned out
     * to protect the rare case at the cost of the common one. A key the running validator has no schema
     * for controls nothing, and for a RETIRED key deleting it is the entire fix, so the banner was telling
     * the reader not to do the one thing that works. Deletion now leads, and it is mechanical.
     */
    it('names deletion as the PRIMARY cure, and the command that performs it', () => {
        expect(banner).toContain('DO delete any key reported as an unknown rule');
        expect(banner).toContain('pnpm wp-prune-unknown-config');
        expect(banner).not.toContain('Do NOT delete a key just because it is reported unknown');
    });

    // The stale pin is real but secondary: it has its own guard, which denies tool calls BEFORE this
    // validator runs. Keeping it in the banner is what stops delete-first from being destructive advice.
    it('keeps the stale PIN as a secondary note, and says why you are not in that case', () => {
        expect(banner).toContain('Secondary, and rare');
        expect(banner).toContain('package.json pins an @webpieces OLDER');
        expect(banner).toContain('version-drift guard');
    });

    // Nothing pointed at the machine-local file during the incident, though a flag in it was the cause.
    it('points machine-local settings at ~/.webpieces/config.json', () => {
        expect(banner).toContain('~/.webpieces/config.json');
        expect(banner).toContain('experimental');
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
 * NO INSTALLER COMMAND, EVER — and no error count that could bring one back.
 *
 * The banner used to grow an OPTIONAL paragraph naming an installer flag once enough errors looked like
 * ones a bulk migrator could apply. That flag is gone, and so is the branch: an optional second command
 * is precisely how a reader comes to believe the one stated cure is a choice. These assert the banner is
 * identical in KIND for one retired key and for a sweep of them.
 */
describe('config-error banner — never names an installer command', () => {
    it('omits it for a SINGLE retired key', () => {
        const banner = formatConfigErrorsBanner([retiredKeyError(RETIRED_CONFIG_KEYS[0])]);
        expect(banner).not.toContain('wp-install-ai-hooks');
        expect(banner).not.toContain('OPTIONAL');
    });

    it('omits it for TWO retired keys — a sweep earns no extra paragraph', () => {
        const banner = formatConfigErrorsBanner([
            retiredKeyError(RETIRED_CONFIG_KEYS[0]),
            retiredKeyError(RETIRED_CONFIG_KEYS[1]),
        ]);
        expect(banner).not.toContain('wp-install-ai-hooks');
        expect(banner).not.toContain('OPTIONAL');
    });

    // The two banners differ ONLY in the bullets, which is the whole claim: nothing is conditional.
    it('says the same thing either way, bullets aside', () => {
        const one = formatConfigErrorsBanner(['first error']);
        const two = formatConfigErrorsBanner(['first error', 'second error']);
        expect(two.replace('  • second error\n', '').replace('has 2 validation', 'has 1 validation'))
            .toBe(one);
    });
});

/**
 * ANTI-DRIFT. The markers are imported by the message builders rather than re-typed, but that only
 * proves the string is shared — not that the builder still EMITS it. So drive REAL validator output
 * through them: if a message is reworded away from its marker, these go red.
 */
describe('config-error banner — the markers match what the validators actually emit', () => {
    it('every RETIRED_CONFIG_KEYS message carries its marker', () => {
        for (const entry of RETIRED_CONFIG_KEYS) {
            expect(retiredKeyError(entry), `entry ${entry.key}`).toContain(RETIRED_KEY_MARKER);
        }
    });

    it('a guard left in `rules` and a code rule left in `hookGuards` both carry the marker', () => {
        const guardInRules = validateSectionPlacement({ 'pr-merge-guard': {} }, {});
        const ruleInGuards = validateSectionPlacement({}, { 'max-file-lines': {} });
        expect(guardInRules).toHaveLength(1);
        expect(ruleInGuards).toHaveLength(1);
        for (const message of [...guardInRules, ...ruleInGuards]) {
            expect(message).toContain(SECTION_PLACEMENT_MARKER);
        }
    });

    it('the retired TOP-LEVEL pr-gate block carries its marker', () => {
        const errors = validateCommandsSection(undefined, { mode: 'OFF' });
        const topLevel = errors.filter((e: string): boolean => e.includes(RETIRED_TOP_LEVEL_MARKER));
        expect(topLevel).toHaveLength(1);
    });

    // The retired table is the migration worklist; a scope it stops covering must be caught here.
    it('every retired entry carries a destination the banner can point at', () => {
        for (const entry of RETIRED_CONFIG_KEYS) {
            const typed: RetiredConfigKey = entry;
            expect(typed.instruction.length, `entry ${typed.key}`).toBeGreaterThan(0);
        }
    });
});
