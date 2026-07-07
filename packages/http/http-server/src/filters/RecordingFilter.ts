import { inject, injectable } from 'inversify';
import {
    provideFrameworkSingleton,
    MethodMeta,
    RequestContextReader,
    WebpiecesConfig,
    WEBPIECES_CONFIG_TOKEN,
} from '@webpieces/http-routing';
import { RequestContext } from '@webpieces/core-context';
import { Filter, WpResponse, Service } from '@webpieces/http-filters';
import {
    HeaderMethods,
    HeaderRegistry,
    RecordedEndpoint,
    RecordedError,
    RecorderKeys,
    WebpiecesCoreHeaders,
    toError,
} from '@webpieces/core-util';

import { TestCaseRecorderImpl } from '../recorder/TestCaseRecorderImpl';

/**
 * RecordingFilter - Records a request as a replayable test case (port of Java
 * RecordingFilter).
 *
 * Suggested priority: 1850 (after ContextFilter 2000 so the RECORDING header
 * has been transferred to the context, after AuthFilter 1900 so only real
 * authorized flows are recorded, before LogApiFilter 1800).
 *
 * Activates when WebpiecesConfig.recordingAlwaysOn is set OR the request
 * carries WebpiecesCoreHeaders.RECORDING (x-webpieces-recording). While
 * active, a TestCaseRecorderImpl travels in the RequestContext under
 * RecorderKeys.RECORDER; the http-client proxy and recordable() wrappers add
 * every downstream call. On completion the fixture + generated spec are
 * logged (and written to config.recordingDir when set).
 *
 * Recording NEVER alters the response - failures inside the recorder are
 * caught and logged.
 */
@provideFrameworkSingleton()
@injectable()
// webpieces-disable no-any-unknown -- Filter generic params use unknown for response type flexibility
export class RecordingFilter extends Filter<MethodMeta, WpResponse<unknown>> {
    private headerMethods = new HeaderMethods();

    constructor(
        @inject(WEBPIECES_CONFIG_TOKEN) private config: WebpiecesConfig,
    ) {
        super();
    }

    // webpieces-disable no-any-unknown -- Filter generic params use unknown for response type flexibility
    async filter(
        meta: MethodMeta,
        nextFilter: Service<MethodMeta, WpResponse<unknown>>,
    ): Promise<WpResponse<unknown>> {
        if (!this.isRecordingRequested()) {
            return await nextFilter.invoke(meta);
        }

        const recorder = new TestCaseRecorderImpl();
        RequestContext.putHeader(RecorderKeys.RECORDER, recorder);

        const serverEndpoint = this.buildServerEndpoint(meta);

        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- capture failure into the recording, then rethrow unchanged
        try {
            const response = await nextFilter.invoke(meta);
            serverEndpoint.successResponse = response.response;
            return response;
        } catch (err: unknown) {
            const error = toError(err);
            serverEndpoint.failureResponse = new RecordedError(error.name, error.message);
            throw err;
        } finally {
            RequestContext.remove(RecorderKeys.RECORDER.name);
            recorder.spitOutTestCase(serverEndpoint, this.config.recordingDir);
        }
    }

    private isRecordingRequested(): boolean {
        if (this.config.recordingAlwaysOn) {
            return true;
        }
        // ContextFilter (priority 2000) already transferred the header into context
        return RequestContext.hasHeader(WebpiecesCoreHeaders.RECORDING);
    }

    private buildServerEndpoint(meta: MethodMeta): RecordedEndpoint {
        // Masked snapshot of the magic context (secured values masked, keyed by name)
        const logMap = this.headerMethods.buildSecureMapForLogs(HeaderRegistry.get().getLoggedKeys(), new RequestContextReader());
        const ctxSnapshot: Record<string, string> = {};
        for (const entry of logMap.entries()) {
            ctxSnapshot[entry[0]] = entry[1];
        }

        const apiName = meta.routeMeta.controllerClassName ?? 'UnknownController';
        return new RecordedEndpoint(apiName, meta.methodName, [meta.requestDto], ctxSnapshot);
    }
}
