import {
    RecordedEndpoint,
    RecordedError,
    RecorderKeys,
    TestCaseRecorder,
    toError,
} from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';

/**
 * recordable - Wrap an IN-PROCESS api implementation (simulator, local impl)
 * so its calls are captured by an active TestCaseRecorder, exactly like
 * outbound HTTP client calls are. Port of Java ApiRecorder/ApiRecorderCreator.
 *
 * When no recorder is in the request context (the normal case) calls pass
 * straight through with no overhead beyond one context read.
 *
 * Use at DI-binding time:
 * ```typescript
 * bind<RemoteApi>(TYPES.RemoteApi)
 *     .toDynamicValue(() => recordable('RemoteApi', new RemoteServiceSimulator()))
 *     .inSingletonScope();
 * ```
 */
export function recordable<T extends object>(apiName: string, impl: T): T {
    return new Proxy(impl, {
        // webpieces-disable no-any-unknown -- Proxy get trap returns heterogeneous members
        get(target: T, prop: string | symbol, receiver: unknown): unknown {
            const original = Reflect.get(target, prop, receiver);
            if (typeof original !== 'function' || typeof prop !== 'string') {
                return original;
            }

            // webpieces-disable no-any-unknown -- api method args/returns are type-erased in the proxy
            return async (...args: unknown[]): Promise<unknown> => {
                const recorder = RequestContext.getHeader(RecorderKeys.RECORDER) as TestCaseRecorder | undefined;
                if (!recorder) {
                    return await original.apply(target, args);
                }

                const recorded = new RecordedEndpoint(apiName, prop, args);
                recorder.addEndpointInfo(recorded);

                // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- capture failure into the recording, then rethrow unchanged
                try {
                    const response = await original.apply(target, args);
                    recorded.successResponse = response;
                    return response;
                } catch (err: unknown) {
                    const error = toError(err);
                    recorded.failureResponse = new RecordedError(error.name, error.message);
                    throw err;
                }
            };
        },
    });
}
