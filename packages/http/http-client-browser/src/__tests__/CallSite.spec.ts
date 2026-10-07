import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    ApiCallSite,
    ApiDependencyError,
    ApiPath,
    AuthorizationType,
    ClientRegistry,
    ClientRole,
    Endpoint,
    ErrorTranslator,
    HeaderRegistry,
    HttpResponseDto,
    POST,
    ReportableApiFailure,
    Rpc,
    RPC,
    WebpiecesDefaultErrorTranslator,
    WpAuthorization,
    WpAuthPublic,
    WRITE,
} from '@webpieces/core-util';
import { ClientConfig } from '../ClientConfig';
import { ClientHttpBrowserFactory } from '../ClientHttpBrowserFactory';
import { MutableContextStore } from '../MutableContextStore';

class SaveRequest {
    constructor(public readonly query: string) {}
}

@Rpc()
@ApiPath('/public')
abstract class SaveApi {
    @Endpoint(POST, '/save', WRITE, RPC)
    @WpAuthPublic('Anonymous access is intentionally required')
    @WpAuthorization({
        authType: AuthorizationType.ANONYMOUS,
        reason: 'Anonymous access is intentionally required',
    })
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    save(_request: SaveRequest): Promise<void> {
        throw new Error('contract only');
    }
}

/** An app's own error type, thrown by its own translator: NOT an ApiError. */
class AppRejectedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AppRejectedError';
    }
}

/** Throws ONE known instance for every failure, so the spec can prove the very same object arrives. */
class InstanceThrowingTranslator implements ErrorTranslator {
    private readonly fallback = new WebpiecesDefaultErrorTranslator();
    constructor(private readonly instance: AppRejectedError) {}
    toWire(error: Error): HttpResponseDto {
        return this.fallback.toWire(error);
    }
    fromWire(response: HttpResponseDto, role: ClientRole): void {
        if (response.status.code >= 400) throw this.instance;
        this.fallback.fromWire(response, role);
    }
}

// webpieces-disable no-function-outside-class -- stub transport for this spec
function stubFetch500(): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(() =>
            Promise.resolve(
                new Response(JSON.stringify({ kind: 'implementation', message: 'boom' }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                }),
            ),
        ),
    );
}

// webpieces-disable no-function-outside-class -- the NAMED app frame the captured stack must show
async function onSaveButtonClicked(client: SaveApi): Promise<unknown> {
    // webpieces-disable no-unmanaged-exceptions -- the rejection IS what this spec inspects
    return client.save(new SaveRequest('q')).catch((err: unknown) => err);
}

beforeEach(() => {
    HeaderRegistry.configure([], /*platformHeaders*/ true);
    ClientRegistry.resetForTests();
    ClientRegistry.addUrlMapping('save-svc', 'https://save.example.com');
});

afterEach(() => {
    ClientRegistry.resetForTests();
    vi.unstubAllGlobals();
});

describe('browser api clients capture the caller stack on a failed call (#1175)', () => {
    it('the rejected ApiError carries a callSite whose top frame is the app code, not ProxyClient', async () => {
        stubFetch500();
        const client = new ClientHttpBrowserFactory(new MutableContextStore()).createRpcClient(
            SaveApi,
            new ClientConfig('save-svc', ClientRole.END_USER_CLIENT),
        );

        const failure = await onSaveButtonClicked(client);

        expect(failure).toBeInstanceOf(ApiDependencyError);
        const callSite = (failure as ApiDependencyError).callSite;
        expect(callSite).toBeInstanceOf(ApiCallSite);
        expect(callSite!.label).toBe('SaveApi.save');
        const frames = (callSite!.stack ?? '').split('\n').slice(1);
        expect(frames[0]).toContain('onSaveButtonClicked');
        expect(frames.join('\n')).not.toContain('ProxyClient');
        // The error's OWN stack is still the framework's — the call site is the added information.
        expect((failure as Error).stack ?? '').not.toContain('onSaveButtonClicked');
        expect(Object.keys(failure as object)).not.toContain('callSite');

        const report = ReportableApiFailure.toReportableError(failure);
        expect(report!.fingerprint).toEqual(['ApiDependencyError', 'SaveApi.save']);
        expect(report!.error.cause).toBe(failure);
    });

    it('rejects with the SAME instance the translator threw — identity and class intact', async () => {
        stubFetch500();
        const instance = new AppRejectedError('portal suspended');
        ClientRegistry.setErrorTranslator(new InstanceThrowingTranslator(instance));
        const client = new ClientHttpBrowserFactory(new MutableContextStore()).createRpcClient(
            SaveApi,
            new ClientConfig('save-svc', ClientRole.END_USER_CLIENT),
        );

        const failure = await onSaveButtonClicked(client);

        expect(failure).toBe(instance);
        expect(failure).toBeInstanceOf(AppRejectedError);
        expect(ApiCallSite.of(failure)?.label).toBe('SaveApi.save');
    });
});
