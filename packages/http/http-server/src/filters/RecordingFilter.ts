import { inject } from 'inversify';
import {
    provideFrameworkSingleton,
    MethodMeta,
    WebpiecesConfig,
    WEBPIECES_CONFIG_TOKEN,
} from '@webpieces/http-routing';
import { RequestContext } from '@webpieces/core-context';
import { Filter, WpResponse, Service } from '@webpieces/http-routing';
import {
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
 * Suggested priority: 1850 — a user-filter priority that runs BELOW the fixed
 * framework filters (LogApiFilter 1,000,000 outermost, AuthFilter 900,000), so
 * only real authorized flows are recorded.
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
// webpieces-disable no-any-unknown -- Filter generic params use unknown for response type flexibility
export class RecordingFilter extends Filter<MethodMeta, WpResponse<unknown>> {

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
        const logMap = RequestContext.buildLogFields();
        const ctxSnapshot: Record<string, string> = {};
        for (const entry of logMap.entries()) {
            ctxSnapshot[entry[0]] = entry[1];
        }

        const apiName = meta.routeMeta.apiName ?? meta.routeMeta.controllerClassName ?? 'UnknownApi';
        return new RecordedEndpoint(apiName, meta.methodName, [meta.requestDto], ctxSnapshot);
    }
}
