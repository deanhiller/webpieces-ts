import { ContextKey, HeaderRegistry } from '@webpieces/core-util';
import { RequestContext } from '../RequestContext';
import { PendingWireTrust } from '../PendingWireTrust';
import { RequestContextHeaders } from '../RequestContextHeaders';
import { HttpRequest } from '../HttpRequest';

/**
 * The RUNTIME half of the trust guarantee. The compile-time half — that `getTrusted` refuses an
 * untrusted key and `putUntrusted` refuses a trusted one — is pinned by
 * `RequestContextTrustCompileAssertions`, which a spec file cannot express (vitest strips types).
 *
 * What is left to prove here is everything a type cannot say:
 *  - the raw string accessors cannot be used to launder a registered key,
 *  - an inbound trusted header does NOT land in the context, and
 *  - an inbound untrusted header still does.
 */
const USER_ID = ContextKey.trusted<string>('userId', 'jwt claim `sub`, stamped by AuthFilter', 'x-user-id');
const TENANT = ContextKey.untrusted<string>('tenantId', 'x-tenant-id');

function configure(): void {
    HeaderRegistry.configure([USER_ID, TENANT], /*platformHeaders*/ true);
}

describe('ContextKey trust', () => {
    beforeEach(configure);

    describe('the raw string accessors cannot bypass the typed verbs', () => {
        it('get(name) REJECTS a registered key name and names the verbs to use', () => {
            RequestContext.run(() => {
                expect(() => RequestContext.get<string>('userId'))
                    .toThrow(/registered ContextKey \(trust: 'trusted'\).*getTrusted/s);
            });
        });

        it('put(name, value) REJECTS a registered key name — the forgery path', () => {
            RequestContext.run(() => {
                expect(() => RequestContext.put('userId', 'attacker'))
                    .toThrow(/registered ContextKey \(trust: 'trusted'\).*putTrusted/s);
            });
        });

        it('rejects an UNTRUSTED registered key too — the rule is about naming the verb, not about danger', () => {
            RequestContext.run(() => {
                expect(() => RequestContext.get<string>('tenantId'))
                    .toThrow(/registered ContextKey \(trust: 'untrusted'\)/);
            });
        });

        it('still allows the framework reserved slots, which are deliberately unregistered', () => {
            RequestContext.run(() => {
                RequestContext.put('__webpieces_something__', 'plumbing');
                expect(RequestContext.get<string>('__webpieces_something__')).toBe('plumbing');
            });
        });
    });

    describe('inbound wire headers are routed by trust', () => {
        it('an UNTRUSTED header lands in the context immediately', () => {
            RequestContext.run(() => {
                new RequestContextHeaders().fillFromRequest(
                    new HttpRequest('POST', '/x', new Map([['x-tenant-id', ['tenant-9']]])),
                );
                expect(RequestContext.getUntrusted(TENANT)).toBe('tenant-9');
            });
        });

        it('a TRUSTED header does NOT — it is held pending until an authenticator vouches', () => {
            RequestContext.run(() => {
                new RequestContextHeaders().fillFromRequest(
                    new HttpRequest('POST', '/x', new Map([['x-user-id', ['victim']]])),
                );
                // THE forgery case: before this change, `curl -H 'x-user-id: victim'` put a value
                // straight into the slot getTrusted reads.
                expect(RequestContext.getTrusted(USER_ID)).toBeUndefined();
            });
        });

        it('the held value is recoverable exactly once, with the key that carried it', () => {
            RequestContext.run(() => {
                new RequestContextHeaders().fillFromRequest(
                    new HttpRequest('POST', '/x', new Map([['x-user-id', ['victim']]])),
                );
                const pending = PendingWireTrust.takeAll();
                expect(pending.map(p => [p.key.name, p.value])).toEqual([['userId', 'victim']]);
                // Cleared in the same step, so reconciliation cannot run twice.
                expect(PendingWireTrust.takeAll()).toEqual([]);
            });
        });
    });
});
