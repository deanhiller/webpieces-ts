import { ContextKey } from '../../ContextKey';
import { RecordedEndpoint } from './RecordedEndpoint';

/**
 * TestCaseRecorder - Records every api call made while serving one inbound
 * request (port of Java TestCaseRecorder).
 *
 * The recorder travels in the request's magic context under
 * RecorderKeys.RECORDER (Java: Context RECORDER_KEY). Downstream hooks -
 * the HTTP client proxy and recordable() in-process wrappers - check the
 * context and record into it when present.
 *
 * The contract lives in http-api (browser-safe, no Node imports) so the
 * http-client can reference it; the implementation (TestCaseRecorderImpl)
 * lives in http-server.
 */
export interface TestCaseRecorder {
    /**
     * Record one downstream api call (outbound HTTP or in-process recordable).
     */
    addEndpointInfo(info: RecordedEndpoint): void;

    /**
     * The most recently recorded downstream call (for hooks that fill in the
     * response after the call completes).
     */
    getLastEndpointInfo(): RecordedEndpoint | undefined;
}

/**
 * Context keys for the recording subsystem.
 */
export class RecorderKeys {
    /**
     * Key under which the active TestCaseRecorder travels in the request
     * context. Absent = not recording.
     */
    static readonly RECORDER = new ContextKey('webpieces-recorder', undefined, false, /*isLogged*/ false);
}
