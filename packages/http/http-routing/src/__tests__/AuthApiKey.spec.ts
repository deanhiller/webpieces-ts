import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { GcpOidc } from '@webpieces/gcp-identity';
import { HttpRequest, RequestContext, PendingWireTrust } from '@webpieces/core-context';
import {
    AuthMeta,
    ContextKey,
    ContextTuple,
    DestinationTrust,
    HttpUnauthorizedError,
    RouteMetadata,
} from '@webpieces/core-util';
import { AuthFilter } from '../filters/AuthFilter';
import { DefaultOidcVerifier } from '../DefaultOidcVerifier';
import { ApiKeyHook, HeaderReader } from '../AuthHooks';
import { AuthValues } from '../AuthConfig';
import { MethodMeta } from '../MethodMeta';
import { WpResponse, Service } from '../Filter';

/**
 * The ENFORCEMENT half of `@AuthApiKey` (the contract half is pinned in core-util's
 * `apikey-decorator.spec.ts`, and the type-level half in `AuthApiKeyCompileAssertions.ts`).
 *
 * Two properties are being held down here, and the second is the reason the mode exists at all:
 *
 *  1. An async, whole-headers hook seeds `RequestContext` from a datastore lookup, or the request 401s.
 *  2. `apikey` is caller-NOT-verified. A CUSTOMER holding an api key must never license the framework
 *     to believe the trusted context headers that customer forwarded — that would be a
 *     privilege-escalation path (assert someone else's org id on the wire and have it admitted).
 */

/** The organization the partner is acting for — a TRUSTED key, so only an authenticator may write it. */
const ORG_ID = ContextKey.trusted<string>(
    'orgId',
    'derived from a verified customer api key by an app-bound ApiKeyHook (a ContextTuple in AuthValues)',
    'x-org-id',
);

const API_KEY_ROUTE = new RouteMetadata(
    'POST', '/management/v1/orders', 'listOrders', 'ManagementController',
    new AuthMeta({ kind: 'apikey', name: 'onetablet-partner' }), 'ManagementApi',
);

/** Records whether the chain got past AuthFilter at all — i.e. whether the controller was entered. */
class RecordingNext implements Service<MethodMeta, WpResponse<unknown>> {
    invoked = false;
    /** What the controller could read out of RequestContext, captured at the moment it ran. */
    orgIdSeenByController?: string;

    async invoke(_meta: MethodMeta): Promise<WpResponse<unknown>> {
        this.invoked = true;
        this.orgIdSeenByController = RequestContext.getTrusted(ORG_ID);
        return new WpResponse<unknown>({});
    }
}

/**
 * Exactly what an app's hook is: read BOTH credential headers, cross-check them the way a datastore
 * lookup would, and return the context to seed. Nothing here is framework-configured — the header
 * names are this class's business, which is the whole reason `verifyApiKey` takes a reader.
 */
class TestApiKeyHook extends ApiKeyHook {
    seenName?: string;
    seenKey?: string;
    seenOrgId?: string;

    /** name -> the ONE (key, org) pair this regime accepts; stands in for the datastore. */
    private readonly records = new Map<string, [string, string]>([
        ['onetablet-partner', ['live-key-123', 'org-777']],
    ]);

    override async verifyApiKey(name: string, headers: HeaderReader): Promise<AuthValues> {
        // Async on purpose: a real hook awaits a datastore here.
        await Promise.resolve();
        this.seenName = name;
        this.seenKey = headers.getHeader('x-api-key');
        this.seenOrgId = headers.getHeader('x-org-id');
        const record = this.records.get(name);
        if (!record || record[0] !== this.seenKey || record[1] !== this.seenOrgId) {
            throw new HttpUnauthorizedError('api key / organization mismatch');
        }
        return new AuthValues('apikey-1', [], [new ContextTuple(ORG_ID, record[1])]);
    }
}

function newAuthFilter(hook?: ApiKeyHook): AuthFilter {
    return new AuthFilter(
        new DefaultOidcVerifier(new GcpOidc()),
        /*authConfig*/ undefined,
        /*jwtHook*/ undefined,
        /*oidcHook*/ undefined,
        /*webhookAuthCallback*/ undefined,
        hook,
    );
}

function partnerRequest(headers: Record<string, string>): HttpRequest {
    const map = new Map<string, string[]>();
    for (const name of Object.keys(headers)) {
        map.set(name, [headers[name]]);
    }
    return new HttpRequest('POST', '/management/v1/orders', map);
}

/**
 * Run AuthFilter over the api-key route inside a request scope carrying `request`, plus whatever
 * trusted values arrived ON THE WIRE.
 *
 * `PendingWireTrust.stash` is exactly what the TRANSPORT does with an inbound trusted header
 * (`RequestContextHeaders.fillFromRequest` never writes one straight into the context), so stashing
 * here reproduces the real pre-filter state without standing up a HeaderRegistry. The reconciliation
 * these specs are about only happens because something stashed first.
 */
async function runFilter(
    next: RecordingNext,
    hook: ApiKeyHook | undefined,
    request: HttpRequest,
    onTheWire: ContextTuple[] = [],
): Promise<WpResponse<unknown>> {
    return RequestContext.run(async () => {
        RequestContext.setRequest(request);
        for (const tuple of onTheWire) {
            PendingWireTrust.stash(tuple.key, String(tuple.value));
        }
        return newAuthFilter(hook).filter(new MethodMeta(API_KEY_ROUTE), next);
    });
}

describe('AuthFilter enforces @AuthApiKey', () => {
    it('hands the hook the regime name and the WHOLE header set, so it can cross-check the pair', async () => {
        const hook = new TestApiKeyHook();
        const next = new RecordingNext();

        await runFilter(next, hook, partnerRequest({ 'x-api-key': 'live-key-123', 'x-org-id': 'org-777' }));

        expect(hook.seenName).toBe('onetablet-partner');
        expect(hook.seenKey).toBe('live-key-123');
        expect(hook.seenOrgId).toBe('org-777');
        expect(next.invoked).toBe(true);
    });

    it('seeds the returned ContextTuple entries so the CONTROLLER reads them off RequestContext', async () => {
        const next = new RecordingNext();

        await runFilter(next, new TestApiKeyHook(), partnerRequest({ 'x-api-key': 'live-key-123', 'x-org-id': 'org-777' }));

        // This is the point of reusing AuthValues: putTrusted, the path that already existed.
        expect(next.orgIdSeenByController).toBe('org-777');
    });

    it('401s and NEVER enters the controller when the hook rejects the key/organization pair', async () => {
        const next = new RecordingNext();

        await expect(runFilter(next, new TestApiKeyHook(), partnerRequest({ 'x-api-key': 'live-key-123', 'x-org-id': 'org-OTHER' })))
            .rejects.toThrow(HttpUnauthorizedError);
        expect(next.invoked).toBe(false);
    });

    /**
     * FAIL CLOSED, matching JwtHook and WebhookAuthCallback. An app that forgot the binding must not have
     * its partner-facing route silently open.
     */
    it('401s on every api-key endpoint when NO ApiKeyHook is bound', async () => {
        const next = new RecordingNext();

        await expect(runFilter(next, undefined, partnerRequest({ 'x-api-key': 'live-key-123' })))
            .rejects.toThrow(/API-key auth is not enabled/);
        expect(next.invoked).toBe(false);
    });

    /** Backstop for a caller that drove the route in-process without publishing an HttpRequest. */
    it('401s — never waves through — when there is no inbound request for the hook to read', async () => {
        const next = new RecordingNext();

        await expect(RequestContext.run(async () =>
            newAuthFilter(new TestApiKeyHook()).filter(new MethodMeta(API_KEY_ROUTE), next),
        )).rejects.toThrow(/no inbound request was published/);
        expect(next.invoked).toBe(false);
    });
});

/**
 * THE SECURITY CRUX. `apikey` sits in the `false` branch of `verifiesCaller`, with `jwt`, and NOT with
 * `shared-secret`. Getting this wrong ships a privilege-escalation path: a partner would be able to
 * assert another customer's org id in `x-org-id` and have the framework admit it as proven.
 */
describe('@AuthApiKey does NOT verify its caller, so forwarded trusted context is not believed', () => {
    it('rejects an inbound trusted header the hook did not independently derive', async () => {
        const next = new RecordingNext();

        // The partner sends a PERFECTLY VALID credential and, alongside it, asserts a trusted userId
        // the hook vouches for nothing about. Under `shared-secret` this would be admitted as proven.
        const victimKey = ContextKey.trusted<string>('userId', 'a verified user id', 'x-user-id');
        const request = partnerRequest({
            'x-api-key': 'live-key-123',
            'x-org-id': 'org-777',
            'x-user-id': 'someone-elses-user',
        });

        await expect(runFilter(next, new TestApiKeyHook(), request, [
            new ContextTuple(victimKey, 'someone-elses-user'),
        ])).rejects.toThrow(/cannot be supplied by the caller on this endpoint/);
        expect(next.invoked).toBe(false);
    });

    it('admits an inbound trusted header ONLY when the hook derived the very same value', async () => {
        const next = new RecordingNext();

        // Same value the hook proves from the datastore: no contradiction, so the request stands.
        const request = partnerRequest({ 'x-api-key': 'live-key-123', 'x-org-id': 'org-777' });

        await runFilter(next, new TestApiKeyHook(), request, [new ContextTuple(ORG_ID, 'org-777')]);

        expect(next.invoked).toBe(true);
        expect(next.orgIdSeenByController).toBe('org-777');
    });

    /**
     * The OUTBOUND twin of the same rule. If these two ever disagreed, every internal call to such an
     * endpoint would 401 in a way that looks like a framework bug — which is why one spec asserts both.
     */
    it('omits trusted keys outbound too — DestinationTrust puts apikey with jwt, not with shared-secret', () => {
        const trust = DestinationTrust.forAuthMode({ kind: 'apikey', name: 'onetablet-partner' });

        expect(trust.allows(ORG_ID)).toBe(false);
        expect(trust.allows(ContextKey.untrusted<string>('actionId', 'x-action-id'))).toBe(true);
        // Contrast, stated out loud: shared-secret is the branch this mode must NOT be in.
        expect(DestinationTrust.forAuthMode({ kind: 'shared-secret', secretKey: 'k' }).allows(ORG_ID)).toBe(true);
    });
});
