import { describe, it, expect } from 'vitest';

import {
    LEGACY_GUARANTEE_ROOT_MARKER, LEGACY_MARKER_REMOVE_AFTER, expectedEntries, HARNESS_REGISTRATIONS, HarnessRegistration,
    GUARDS_BIN, RULES_BIN, HookRegistrationEntry,
} from './hook-registration';

/**
 * The retirement clock for `LEGACY_GUARANTEE_ROOT_MARKER`.
 *
 * That constant is a removal-only recogniser: it exists so `repairRegistration()` can find and DELETE a
 * settings entry written by the retired three-hook release. It is not a shim — nothing emits it — but it
 * IS dead weight once no consumer can still be carrying that entry.
 *
 * A comment saying "delete this in two releases" is an intention nobody re-reads. This is the reminder,
 * and it is deliberately a FAILING TEST rather than a lint warning, because the alternative failure is
 * silent: delete the marker too early and repair stops stripping the retired entry, leaving a hook
 * registered against a file this release deletes — exit 127, a NON-BLOCKING error per the hooks
 * reference, i.e. every `cd` unjudged while `wp-upgrade-shim` reports success.
 *
 * WHEN THIS GOES RED: do not extend the date reflexively. Check whether any consumer can still hold the
 * old registration. If none can, delete the marker, `isManagedCommand()`'s second clause, this spec and
 * the removal branch it guards. If some can, move the date and say why in the commit.
 */
describe('the retired-hook recogniser has an expiry, not an intention', () => {
    it('is still within its stated window', () => {
        const deadline = new Date(`${LEGACY_MARKER_REMOVE_AFTER}T00:00:00Z`).getTime();
        expect(Number.isNaN(deadline), 'LEGACY_MARKER_REMOVE_AFTER must be YYYY-MM-DD').toBe(false);
        expect(
            Date.now() < deadline,
            `LEGACY_GUARANTEE_ROOT_MARKER was due for deletion after ${LEGACY_MARKER_REMOVE_AFTER}. `
            + 'Read this spec\'s docblock before changing the date.',
        ).toBe(true);
    });

    /**
     * The property that makes it a recogniser rather than a second accepted spelling: it must never
     * appear in what this release WANTS. If it ever does, the two forms coexist and that is the shim the
     * compatibility policy rejects.
     */
    it('is never emitted — it only ever matches what must be removed', () => {
        const wanted = HARNESS_REGISTRATIONS.flatMap(
            (h: HarnessRegistration) => expectedEntries(h, [GUARDS_BIN, RULES_BIN]));
        for (const entry of wanted) {
            expect(entry.command).not.toContain(LEGACY_GUARANTEE_ROOT_MARKER);
        }
        expect(wanted.map((e: HookRegistrationEntry): string => e.command).join())
            .not.toContain('guarantee-root');
    });
});
