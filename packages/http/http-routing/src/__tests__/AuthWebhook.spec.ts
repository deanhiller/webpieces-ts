import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { GcpOidc } from '@webpieces/gcp-identity';
import { HttpRequest, RawRequest, RequestContext } from '@webpieces/core-context';
import {
    ApiPath,
    AuthMeta,
    AuthWebhook,
    Endpoint,
    HttpBadRequestError,
    HttpUnauthorizedError,
    RouteMetadata,
} from '@webpieces/core-util';
import { AuthFilter } from '../filters/AuthFilter';
import { DefaultOidcVerifier } from '../DefaultOidcVerifier';
import { ApiRoutingFactory } from '../ApiRoutingFactory';
import { WebhookAuthCallback } from '../AuthHooks';
import { MethodMeta } from '../MethodMeta';
import { WpResponse, Service } from '../Filter';
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

/** Records whether the chain got past AuthFilter at all — i.e. whether the controller was entered. */
class RecordingNext implements Service<MethodMeta, WpResponse<unknown>> {
    invoked = false;

    async invoke(_meta: MethodMeta): Promise<WpResponse<unknown>> {
        this.invoked = true;
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

    override async verify(name: string, request: HttpRequest, raw: RawRequest): Promise<void> {
        this.seenName = name;
        this.seenBody = raw.rawBody;
        this.seenUrl = raw.absoluteUrl;
        this.seenSignature = request.getHeader('sentry-hook-signature');
        if (!this.allow) {
            throw new HttpUnauthorizedError('signature mismatch');
        }
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
): Promise<WpResponse<unknown>> {
    return RequestContext.run(async () => {
        RequestContext.setRequest(request);
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
