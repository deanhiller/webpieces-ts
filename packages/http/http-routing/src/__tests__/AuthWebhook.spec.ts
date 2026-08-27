import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { GcpOidc } from '@webpieces/gcp-identity';
import { HttpRequest, PendingWireTrust, RawHttpRequest, RawRequest, RequestContext } from '@webpieces/core-context';
import {
    ApiPath,
    AuthMeta,
    AuthWebhook,
    ContextKey,
    ContextTuple,
    Endpoint,
    HttpBadRequestError,
    HttpUnauthorizedError,
    RouteMetadata,
} from '@webpieces/core-util';
import { AuthFilter } from '../filters/AuthFilter';
import { DefaultOidcVerifier } from '../DefaultOidcVerifier';
import { ApiRoutingFactory } from '../ApiRoutingFactory';
import { WebhookAuthCallback } from '../AuthHooks';
import { AuthenticatedCaller, AUTHENTICATED_CALLER_KEY } from '../AuthConfig';
import { MethodMeta } from '../MethodMeta';
import { Service } from '@webpieces/core-util';
import { WpResponse } from '../WpResponse';
import { RouteBuilder, RouteDefinition, FilterDefinition } from '../WebAppMeta';

/**
 * The ENFORCEMENT half of `@AuthWebhook` (the contract half is pinned in core-util's
 * `webhook-decorator.spec.ts`, the transport half in http-server's `ExpressWrapperRawBody.spec.ts`).
 *
 * Everything here is about one property: an `external` endpoint's `calledBy` becomes a FACT instead of
 * a claim, and every way that can go wrong ends in 401 with the controller never entered.
 */

@ApiPath('/hook')
abstract class SentryHookApi {
    @AuthWebhook('sentry')
    @Endpoint('/sentry/issue', 'external', { calledBy: 'sentry', rawBody: true })
    notify(_r: object): Promise<object> {
        throw new Error('subclass');
    }
}

class SentryHookController extends SentryHookApi {
    override async notify(_r: object): Promise<object> {
        return {};
    }
}

@ApiPath('/hook')
abstract class ForgotRawBodyApi {
    @AuthWebhook('sentry')
    @Endpoint('/sentry/issue', 'external', { calledBy: 'sentry' })
    notify(_r: object): Promise<object> {
        throw new Error('subclass');
    }
}

class ForgotRawBodyController extends ForgotRawBodyApi {
    override async notify(_r: object): Promise<object> {
        return {};
    }
}

const WEBHOOK_ROUTE = new RouteMetadata(
    'POST', '/hook/sentry/issue', 'notify', 'SentryHookController',
    new AuthMeta({ kind: 'webhook', name: 'sentry' }), 'SentryHookApi',
    /*formPost*/ false, /*mask*/ undefined, /*rawBody*/ true,
);

/**
 * The vendor ACCOUNT a signed payload belongs to — a TRUSTED key, so only an authenticator may write
 * it. Proving the signature proves the account, which is exactly what `verifyWebhook` now returns.
 */
const VENDOR_ACCOUNT = ContextKey.trusted<string>(
    'orgId',
    'derived from a verified vendor signature by an app-bound WebhookAuthCallback (a ContextTuple in AuthenticatedCaller)',
    'x-org-id',
);

/** Records whether the chain got past AuthFilter at all — i.e. whether the controller was entered. */
class RecordingNext implements Service<MethodMeta, WpResponse<unknown>> {
    invoked = false;
    /** What the controller could read out of RequestContext, captured at the moment it ran. */
    accountSeenByController?: string;
    callerSeenByController?: AuthenticatedCaller;

    async invoke(_meta: MethodMeta): Promise<WpResponse<unknown>> {
        this.invoked = true;
        this.accountSeenByController = RequestContext.getTrusted(VENDOR_ACCOUNT);
        this.callerSeenByController = RequestContext.getTrusted(AUTHENTICATED_CALLER_KEY);
        return new WpResponse<unknown>({});
    }
}

/**
 * Exactly what an app's hook is: it calls the VENDOR's validator over the raw request. Here it records
 * what it was handed and answers from `allow`, which is all a `TestWebhookAuthCallback` in a consumer repo
 * needs to do (acceptance check 10 — a spec that builds the real server and drives it through
 * `createApiClient` can rebind this over WEBHOOK_AUTH_CALLBACK and never touch a real signature).
 */
class TestWebhookAuthCallback extends WebhookAuthCallback {
    seenName?: string;
    seenBody?: Buffer;
    seenUrl?: string;
    seenSignature?: string;

    constructor(private readonly allow: boolean) {
        super();
    }

    /**
     * `request.raw` is read with NO `!` and NO guard — that is the point of {@link RawHttpRequest}.
     * AuthFilter checked the bytes are there once, and the type carries the result here.
     */
    override async verifyWebhook(name: string, request: RawHttpRequest): Promise<AuthenticatedCaller> {
        this.seenName = name;
        this.seenBody = request.raw.rawBody;
        this.seenUrl = request.raw.absoluteUrl;
        this.seenSignature = request.getHeader('sentry-hook-signature');
        if (!this.allow) {
            throw new HttpUnauthorizedError('signature mismatch');
        }
        // Proving the signature proved WHICH vendor account this payload is for — a hook that could
        // only return void had no way to say so, and the controller had to re-derive it.
        return new AuthenticatedCaller('sentry-account', [], [new ContextTuple(VENDOR_ACCOUNT, 'org-777')]);
    }
}

class CollectingRouteBuilder implements RouteBuilder {
    readonly paths: string[] = [];

    addRoute(route: RouteDefinition): void {
        this.paths.push(route.routeMeta.path);
    }

    addFilter(_filter: FilterDefinition): void {
        // no filters in these tests
    }
}

function newAuthFilter(hook?: WebhookAuthCallback): AuthFilter {
    return new AuthFilter(
        new DefaultOidcVerifier(new GcpOidc()),
        /*authConfig*/ undefined,
        /*jwtHook*/ undefined,
        /*oidcHook*/ undefined,
        hook,
    );
}

/** The inbound request a signed webhook actually looks like, published the way a transport would. */
function webhookRequest(body: string, parseError?: Error): HttpRequest {
    return new HttpRequest(
        'POST',
        '/hook/sentry/issue',
        new Map<string, string[]>([['sentry-hook-signature', ['abc123']]]),
        new RawRequest('https://api.example.com/hook/sentry/issue', Buffer.from(body, 'utf8'), '1.2.3.4', parseError),
    );
}

/** Run AuthFilter over the webhook route inside a request scope carrying `request`. */
async function runFilter(
    next: RecordingNext,
    hook: WebhookAuthCallback | undefined,
    request: HttpRequest,
    onTheWire: ContextTuple[] = [],
): Promise<WpResponse<unknown>> {
    return RequestContext.run(async () => {
        RequestContext.setRequest(request);
        // Exactly what the TRANSPORT does with an inbound trusted header: stash it PENDING, never
        // write it. The reconciliation these specs are about only happens because something stashed.
        for (const tuple of onTheWire) {
            PendingWireTrust.stash(tuple.key, String(tuple.value));
        }
        return newAuthFilter(hook).filter(new MethodMeta(WEBHOOK_ROUTE), next);
    });
}

describe('AuthFilter enforces @AuthWebhook', () => {
    it('hands the hook the vendor name, the verbatim bytes, the absolute url and the headers', async () => {
        const hook = new TestWebhookAuthCallback(true);
        const next = new RecordingNext();

        await runFilter(next, hook, webhookRequest('{"title":"boom"}'));

        expect(hook.seenName).toBe('sentry');
        expect(hook.seenBody?.toString('utf8')).toBe('{"title":"boom"}');
        expect(hook.seenUrl).toBe('https://api.example.com/hook/sentry/issue');
        expect(hook.seenSignature).toBe('abc123');
        expect(next.invoked).toBe(true);
    });

    it('401s and NEVER enters the controller when the hook rejects the signature', async () => {
        const next = new RecordingNext();

        await expect(runFilter(next, new TestWebhookAuthCallback(false), webhookRequest('{}')))
            .rejects.toThrow(HttpUnauthorizedError);
        expect(next.invoked).toBe(false);
    });

    /**
     * FAIL CLOSED, matching JwtHook. An app that forgot the binding must not have its webhook route
     * silently open — that is the one default that cannot be the other way round.
     */
    it('401s on every webhook endpoint when NO WebhookAuthCallback is bound', async () => {
        const next = new RecordingNext();

        await expect(runFilter(next, undefined, webhookRequest('{}')))
            .rejects.toThrow(/Webhook auth is not enabled/);
        expect(next.invoked).toBe(false);
    });

    /** Backstop for a hand-registered route or an in-process caller that published no raw request. */
    it('401s — never waves through — when the request carries no raw bytes to verify', async () => {
        const next = new RecordingNext();
        const noRaw = new HttpRequest('POST', '/hook/sentry/issue', new Map());

        await expect(runFilter(next, new TestWebhookAuthCallback(true), noRaw))
            .rejects.toThrow(/no raw request was retained/);
        expect(next.invoked).toBe(false);
    });

    it('preserves the bytes EXACTLY — multi-byte UTF-8, an emoji, and an exponent-notation float', async () => {
        // Every one of these differs after a JSON.parse + JSON.stringify round trip, which is why
        // re-stringifying the DTO is not a workaround: the signature would verify in every test and
        // fail on the first real payload.
        const body = '{"title":"café 🚨 crash","rate":1e3}';
        const hook = new TestWebhookAuthCallback(true);

        await runFilter(new RecordingNext(), hook, webhookRequest(body));

        expect(hook.seenBody?.equals(Buffer.from(body, 'utf8'))).toBe(true);
        expect(JSON.stringify(JSON.parse(body))).not.toBe(body); // the trap, stated out loud
    });
});

/**
 * NEW CAPABILITY. `verifyWebhook` returns an {@link AuthenticatedCaller} instead of `void`, so a
 * vendor hook can say WHICH account the signature proved — and the framework seeds it through the
 * SAME `putTrusted` path a jwt or api-key caller takes. Before this, the hook could prove the fact
 * and had no way to hand it on; every controller re-derived it from the payload.
 */
describe('a webhook hook seeds TRUSTED context the controller reads back', () => {
    it('puts the returned ContextTuple entries into RequestContext', async () => {
        const next = new RecordingNext();

        await runFilter(next, new TestWebhookAuthCallback(true), webhookRequest('{"title":"boom"}'));

        expect(next.invoked).toBe(true);
        expect(next.accountSeenByController).toBe('org-777');
    });

    it('stamps the caller under the TRUSTED ContextKey that replaced the principal magic string', async () => {
        const next = new RecordingNext();

        await runFilter(next, new TestWebhookAuthCallback(true), webhookRequest('{}'));

        expect(next.callerSeenByController?.userId).toBe('sentry-account');
        // Context-only: an object principal has no honest header form, and forwarding one would hand
        // the next hop a proof it never made.
        expect(AUTHENTICATED_CALLER_KEY.httpHeader).toBeUndefined();
        expect(AUTHENTICATED_CALLER_KEY.isTrusted()).toBe(true);
    });

    it('stamps NOTHING when the signature fails — a rejected hook returns no caller at all', async () => {
        const next = new RecordingNext();

        await expect(runFilter(next, new TestWebhookAuthCallback(false), webhookRequest('{}')))
            .rejects.toThrow(HttpUnauthorizedError);
        expect(next.accountSeenByController).toBeUndefined();
    });
});

/**
 * THE SECURITY REGRESSION, unchanged by the hook now returning a caller. `webhook` stays in the
 * `false` branch of `verifiesCaller`: the sender is an outside VENDOR, not a peer service, so the
 * trusted context headers arriving alongside a perfectly valid signature are NOT believed. Only a
 * value the hook itself independently derived is admitted.
 */
describe('@AuthWebhook does NOT verify its caller, so forwarded trusted context is not believed', () => {
    it('rejects an inbound trusted header the hook did not independently derive', async () => {
        const next = new RecordingNext();
        const victimKey = ContextKey.trusted<string>('userId', 'a verified user id', 'x-user-id');

        await expect(runFilter(next, new TestWebhookAuthCallback(true), webhookRequest('{}'), [
            new ContextTuple(victimKey, 'someone-elses-user'),
        ])).rejects.toThrow(/cannot be supplied by the caller on this endpoint/);
        expect(next.invoked).toBe(false);
    });

    it('admits an inbound trusted header ONLY when the hook derived the very same value', async () => {
        const next = new RecordingNext();

        await runFilter(next, new TestWebhookAuthCallback(true), webhookRequest('{}'), [
            new ContextTuple(VENDOR_ACCOUNT, 'org-777'),
        ]);

        expect(next.invoked).toBe(true);
        expect(next.accountSeenByController).toBe('org-777');
    });
});

/**
 * ORDER: verify, THEN parse. A 400 tells an unauthenticated caller "your JSON was bad", which also
 * tells it "I got past auth" — a free oracle on an endpoint whose url is public by construction.
 */
describe('a malformed body answers 401 before it answers 400', () => {
    it('401s when the signature does not verify, saying nothing about the body', async () => {
        const next = new RecordingNext();
        const parseError = new Error('Unexpected token');

        await expect(runFilter(next, new TestWebhookAuthCallback(false), webhookRequest('not json', parseError)))
            .rejects.toThrow(HttpUnauthorizedError);
        expect(next.invoked).toBe(false);
    });

    it('400s once — and only once — the caller is PROVEN, with the controller still never entered', async () => {
        const next = new RecordingNext();
        const parseError = new Error('Unexpected token');

        await expect(runFilter(next, new TestWebhookAuthCallback(true), webhookRequest('not json', parseError)))
            .rejects.toThrow(HttpBadRequestError);
        expect(next.invoked).toBe(false);
    });
});

describe('ApiRoutingFactory refuses a webhook route that kept no bytes', () => {
    it('throws at WIRING time, naming the endpoint and the fix', () => {
        expect(() => new ApiRoutingFactory(ForgotRawBodyApi, ForgotRawBodyController)
            .configure(new CollectingRouteBuilder()))
            .toThrow(/is @AuthWebhook.*rawBody: true/s);
    });

    it('registers the route, carrying rawBody on its metadata, when the pairing is right', () => {
        const builder = new CollectingRouteBuilder();

        new ApiRoutingFactory(SentryHookApi, SentryHookController).configure(builder);

        expect(builder.paths).toEqual(['/hook/sentry/issue']);
    });
});
