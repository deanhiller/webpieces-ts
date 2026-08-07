import { ContextKey, HeaderRegistry } from '@webpieces/core-util';
import { RequestContext } from '../RequestContext';
import { CapturedContext } from '../CapturedContext';

/**
 * The RUNTIME half of the capture/restore guarantee. The compile-time half — that a hand-built Map,
 * an object literal, `new CapturedContext(...)` and `CapturedContext.capture(...)` are all rejected —
 * is pinned by `CapturedContextCompileAssertions`, which a spec cannot express (vitest strips types).
 *
 * What is left to prove here is everything a type cannot say:
 *  - a snapshot round-trips, INCLUDING trusted values (restoring what was proven is the whole point),
 *  - a caller who keeps writing to the live context after capturing cannot reach into the snapshot,
 *  - the snapshot's entries are unreachable at RUNTIME too, not merely un-typed.
 */
const USER_ID = ContextKey.trusted<string>('userId', 'jwt claim `sub`, stamped by AuthFilter', 'x-user-id');
const TENANT = ContextKey.untrusted<string>('tenantId', 'x-tenant-id');

function configure(): void {
    HeaderRegistry.configure([USER_ID, TENANT], /*platformHeaders*/ true);
}

describe('CapturedContext', () => {
    beforeEach(configure);

    describe('round trip', () => {
        it('carries TRUSTED values across a re-rooted scope via runWithContext', () => {
            const captured = RequestContext.run(() => {
                RequestContext.putTrusted(USER_ID, 'user-42');
                RequestContext.putUntrusted(TENANT, 'acme');
                return RequestContext.copyContext();
            });

            // Outside any scope now — exactly the "the async chain was broken" situation.
            expect(RequestContext.isActive()).toBe(false);

            RequestContext.runWithContext(captured, () => {
                expect(RequestContext.getTrusted(USER_ID)).toBe('user-42');
                expect(RequestContext.getUntrusted(TENANT)).toBe('acme');
            });
        });

        it('restoreContext overwrites an ALREADY-ACTIVE scope', () => {
            const captured = RequestContext.run(() => {
                RequestContext.putTrusted(USER_ID, 'user-42');
                return RequestContext.copyContext();
            });

            RequestContext.run(() => {
                RequestContext.putTrusted(USER_ID, 'someone-else');
                RequestContext.putUntrusted(TENANT, 'stale');
                RequestContext.restoreContext(captured);
                expect(RequestContext.getTrusted(USER_ID)).toBe('user-42');
                // Overwrite, not merge: an entry the snapshot does not have must be gone.
                expect(RequestContext.getUntrusted(TENANT)).toBeUndefined();
            });
        });

        it('a snapshot is REUSABLE — restoring twice yields the same values both times', () => {
            const captured = RequestContext.run(() => {
                RequestContext.putTrusted(USER_ID, 'user-42');
                return RequestContext.copyContext();
            });

            RequestContext.runWithContext(captured, () => {
                RequestContext.putTrusted(USER_ID, 'mutated-inside-the-restored-scope');
            });
            RequestContext.runWithContext(captured, () => {
                expect(RequestContext.getTrusted(USER_ID)).toBe('user-42');
            });
        });

        it('capturing outside a scope yields an EMPTY snapshot rather than throwing', () => {
            const captured = RequestContext.copyContext();
            expect(captured.size()).toBe(0);
            RequestContext.runWithContext(captured, () => {
                expect(RequestContext.getTrusted(USER_ID)).toBeUndefined();
            });
        });

        it('restoreContext with no active scope throws, naming runWithContext', () => {
            const captured = RequestContext.copyContext();
            expect(() => RequestContext.restoreContext(captured)).toThrow(/runWithContext/);
        });
    });

    describe('the snapshot is opaque at RUNTIME, not merely in the type system', () => {
        it('writes to the live context AFTER capturing do not reach the snapshot', () => {
            const captured = RequestContext.run(() => {
                RequestContext.putTrusted(USER_ID, 'user-42');
                const snapshot = RequestContext.copyContext();
                // The caller still holds the live scope and keeps writing to it.
                RequestContext.putTrusted(USER_ID, 'user-99');
                RequestContext.putUntrusted(TENANT, 'added-after-capture');
                return snapshot;
            });

            RequestContext.runWithContext(captured, () => {
                expect(RequestContext.getTrusted(USER_ID)).toBe('user-42');
                expect(RequestContext.getUntrusted(TENANT)).toBeUndefined();
            });
            expect(captured.size()).toBe(1);
        });

        it('exposes NO enumerable entries — no key, cast or Object.* reaches the values', () => {
            const captured = RequestContext.run(() => {
                RequestContext.putTrusted(USER_ID, 'user-42');
                return RequestContext.copyContext();
            });

            expect(Object.keys(captured)).toEqual([]);
            expect(Object.values(captured)).toEqual([]);
            expect(JSON.stringify(captured)).toBe('{}');
            // The `#entries` field is genuinely private: a cast finds nothing to read.
            const pried = captured as unknown as Record<string, unknown>;
            expect(pried['entries']).toBeUndefined();
            expect(pried['#entries']).toBeUndefined();
        });

        it('is nominal at runtime too — a look-alike object is not a CapturedContext', () => {
            expect(new Map() instanceof CapturedContext).toBe(false);
        });
    });
});
