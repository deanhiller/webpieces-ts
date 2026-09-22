import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { sign } from 'jsonwebtoken';
import { GcpOidc } from '@webpieces/gcp-identity';
import { HttpRequest, RequestContext, PendingWireTrust } from '@webpieces/core-context';
import {
    ApiUnauthorizedError,
    AuthMeta,
    AuthMode,
    ContextTuple,
    RouteMetadata,
    Service,
    Surface,
    WebpiecesCoreHeaders,
    WRITE,
} from '@webpieces/core-util';
import { AuthFilter } from '../filters/AuthFilter';
import { DefaultJwtHook } from '../DefaultJwtHook';
import { DefaultOidcVerifier } from '../DefaultOidcVerifier';
import { ApiKeyHook, OidcHook } from '../AuthHooks';
import { AuthenticatedCaller } from '../AuthConfig';
import { MethodMeta } from '../MethodMeta';
import { WpResponse } from '../WpResponse';

const SECRET = 'surface-spec-secret';

/**
 * Issue #968 / R6: WHICH KIND OF CALLER drove this request is a property of the CALLER, set ONCE at
 * the edge from the auth mode that matched, and PROPAGATED unchanged from there.
 *
 * Three things are held down here, and the third is the security one:
 *
 *  1. the mode -> surface table (`@WpAuthJwt` -> gui, `@WpAuthApiKey` -> public-api, and the modes
 *     that are NOT surfaces);
 *  2. a hop that already has a surface keeps it — `@WpAuthOidc` is an internal hop, never a surface;
 *  3. a CALLER cannot set it. `x-wp-surface` is a TRUSTED key, so an inbound value is held pending by
 *     the transport and admitted only where the route verified its caller; anywhere else it must
 *     match what the framework itself derived, or the request 401s.
 */
class RecordingNext implements Service<MethodMeta, WpResponse<unknown>> {
    invoked = false;
    surfaceSeenByController?: Surface;

    async invoke(_meta: MethodMeta): Promise<WpResponse<unknown>> {
        this.invoked = true;
        this.surfaceSeenByController = RequestContext.getTrusted(WebpiecesCoreHeaders.SURFACE);
        return new WpResponse<unknown>({});
    }
}

/** Accepts any caller: these specs are about the SURFACE key, not about OIDC verification. */
class PassingOidcHook extends OidcHook {
    override async verifyOidc(_token: string, _callers: string[]): Promise<void> {
        await Promise.resolve();
    }
}

class OrgApiKeyHook extends ApiKeyHook {
    override async verifyApiKey(
        _regime: string,
        _request: HttpRequest,
    ): Promise<AuthenticatedCaller> {
        await Promise.resolve();
        return new AuthenticatedCaller('partner-1', []);
    }
}

const routeFor = (mode: AuthMode): RouteMetadata =>
    new RouteMetadata(
        'POST',
        '/thing',
        'thing',
        WRITE,
        'ThingController',
        new AuthMeta(mode),
        'ThingApi',
    );

const newAuthFilter = (): AuthFilter =>
    new AuthFilter(
        new DefaultOidcVerifier(new GcpOidc()),
        /*authConfig*/ undefined,
        new DefaultJwtHook(SECRET),
        new PassingOidcHook(),
        /*webhookAuthCallback*/ undefined,
        new OrgApiKeyHook(),
    );

const requestWith = (headers: Record<string, string>): HttpRequest => {
    const map = new Map<string, string[]>();
    for (const name of Object.keys(headers)) map.set(name, [headers[name]]);
    return new HttpRequest('POST', '/thing', map);
};

/**
 * `PendingWireTrust.stash` is exactly what the TRANSPORT does with an inbound trusted header
 * (`RequestContextHeaders.fillFromRequest` never writes one straight into the context), so stashing
 * here reproduces the real pre-filter state without standing up a HeaderRegistry.
 */
const runFilter = (
    next: RecordingNext,
    mode: AuthMode,
    headers: Record<string, string> = {},
    onTheWire: ContextTuple[] = [],
): Promise<WpResponse<unknown>> =>
    RequestContext.run(async () => {
        RequestContext.setRequest(requestWith(headers));
        for (const tuple of onTheWire) {
            PendingWireTrust.stash(WebpiecesCoreHeaders.SURFACE, String(tuple.value));
        }
        return newAuthFilter().filter(new MethodMeta(routeFor(mode)), next);
    });

const jwtHeader = (): Record<string, string> => ({
    authorization: `Bearer ${sign({ sub: 'u1', roles: ['admin'] }, SECRET)}`,
});

describe('AuthFilter stamps SURFACE from the auth mode that matched', () => {
    it('@WpAuthJwt -> gui: a browser GUI holding an end-user JWT', async () => {
        const next = new RecordingNext();

        await runFilter(next, { kind: 'jwt', requirement: { allRolesAllowed: true } }, jwtHeader());

        expect(next.invoked).toBe(true);
        expect(next.surfaceSeenByController).toBe('gui');
    });

    it('@WpAuthApiKey -> public-api: an external partner against a published REST contract', async () => {
        const next = new RecordingNext();

        await runFilter(next, {
            kind: 'apikey',
            regime: 'partner',
            credentials: [{ in: 'header', name: 'x-api-key' }],
        });

        expect(next.invoked).toBe(true);
        expect(next.surfaceSeenByController).toBe('public-api');
    });

    it('a PUBLIC route establishes no surface, so the end-user status keeps its 266 default', async () => {
        const next = new RecordingNext();

        await runFilter(next, { kind: 'public' });

        expect(next.invoked).toBe(true);
        expect(next.surfaceSeenByController).toBeUndefined();
    });

    it('@WpAuthSharedSecret establishes none either — an internal hop RELAYS a surface, it is not one', async () => {
        const next = new RecordingNext();

        await runFilter(next, { kind: 'shared-secret', secretKey: 'nope' }).catch(() => undefined);

        expect(next.surfaceSeenByController).toBeUndefined();
    });
});

describe('SURFACE propagates: the second hop INHERITS the edge hop, it does not re-derive it', () => {
    it('GUI -> api1(@WpAuthJwt) -> api2(@WpAuthOidc): api2 sees gui, not a surface of its own', async () => {
        const next = new RecordingNext();

        // api2's route verifies its CALLER (oidc), so the propagated trusted header is admitted.
        await runFilter(
            next,
            { kind: 'oidc', callers: ['api1@example.iam.gserviceaccount.com'] },
            { authorization: 'Bearer an-oidc-id-token' },
            [new ContextTuple(WebpiecesCoreHeaders.SURFACE, 'gui')],
        );

        expect(next.surfaceSeenByController).toBe('gui');
    });

    it('an LLM surface stamped BEFORE the filter (the MCP bridge) is never overwritten by the mode', async () => {
        const next = new RecordingNext();

        // The MCP bridge invokes the tool's endpoint in-process with a local endpoint JWT. Its HTTP
        // auth mode is `jwt`, which would say `gui` — but the caller is a model, and the bridge
        // already said so.
        await RequestContext.run(async () => {
            RequestContext.setRequest(requestWith(jwtHeader()));
            RequestContext.putTrusted(WebpiecesCoreHeaders.SURFACE, 'llm');
            return newAuthFilter().filter(
                new MethodMeta(routeFor({ kind: 'jwt', requirement: { allRolesAllowed: true } })),
                next,
            );
        });

        expect(next.surfaceSeenByController).toBe('llm');
    });
});

describe('a CALLER cannot set its own surface', () => {
    it('sending x-wp-surface at a PUBLIC endpoint is a 401 — nothing vouched for it', async () => {
        const next = new RecordingNext();

        await expect(
            runFilter(next, { kind: 'public' }, {}, [
                new ContextTuple(WebpiecesCoreHeaders.SURFACE, 'public-api'),
            ]),
        ).rejects.toThrow(ApiUnauthorizedError);
        expect(next.invoked).toBe(false);
    });

    it('sending a DIFFERENT surface at a @WpAuthJwt edge is a 401 — it must match what auth derived', async () => {
        const next = new RecordingNext();

        await expect(
            runFilter(next, { kind: 'jwt', requirement: { allRolesAllowed: true } }, jwtHeader(), [
                new ContextTuple(WebpiecesCoreHeaders.SURFACE, 'public-api'),
            ]),
        ).rejects.toThrow(ApiUnauthorizedError);
        expect(next.invoked).toBe(false);
    });
});
