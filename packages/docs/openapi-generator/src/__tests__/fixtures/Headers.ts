/* eslint-disable */
import { ContextKey } from '@webpieces/core-util';

/**
 * The fixture's typed context-key REGISTRY (#1249): every header defined ONCE, as a ContextKey, and
 * named by that key on every surface — the contracts' api-key credentials and the manifest's
 * response header (`"contextKey": "WidgetKeys.TRACE"`, a dotted path into this class).
 *
 * JSON cannot import, so a header-name literal in the manifest would be a copy a rename here leaves
 * stale — and the published document would then document a header nothing sets.
 */
export class WidgetKeys {
    static readonly API_KEY = ContextKey.untrusted<string>('widgetApiKey', 'x-api-key', true);
    static readonly TRACE = ContextKey.untrusted<string>(
        'traceId',
        'x-trace-id',
        false,
        true,
        /*responseHeader*/ 'x-trace-id',
        'first',
    );
    /** Rides requests only: it has no responseHeader, so a manifest naming it is refused. */
    static readonly REQUEST_ONLY = ContextKey.untrusted<string>('requestOnly', 'x-request-only');
}
