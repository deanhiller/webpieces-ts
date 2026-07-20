/**
 * Centralised classifier for transport rejects — the ONE place in the framework that decides
 * "the request never reached a server" (offline, DNS, connection refused, CORS preflight).
 *
 * Browser-safe: zero node imports, no framework deps beyond {@link OfflineError}. It runs identically
 * in an Angular bundle and on Cloud Run.
 *
 * WHY here and not in each app: the browser-wording list below is inherently incomplete and drifts as
 * engines reword their messages. Kept in one module, an app never writes it, and a new wording is
 * fixed exactly once — here — instead of in every consumer's copy of the same fragile string match.
 */
import { OfflineError } from './errors';

/**
 * The error shape this classifier reads for the node/undici code. `Error.cause` (ES2022) is already
 * on the base type — typed `unknown` there — so we only add the optional `code`; a plain `Error`
 * narrows to this safely since we only ever READ the field.
 */
interface CausedError extends Error {
    code?: string;
}

/**
 * Node/undici system codes that mean the connection never established (or dropped mid-flight before
 * any HTTP response). A real, stable code beats message text, so these are checked FIRST.
 */
const NODE_SYSTEM_CODES: ReadonlySet<string> = new Set([
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNRESET',
    'EPIPE',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'ENETUNREACH',
    'EHOSTUNREACH',
]);

/**
 * Browser `fetch` reject wordings. Substring tests, not equality: zone.js (Angular) may append the
 * request hostname to the message. This list is expected to grow as engines/locales reword.
 */
const BROWSER_REJECT_MESSAGES: readonly string[] = [
    'Failed to fetch',
    'NetworkError when attempting to fetch resource',
    'Load failed',
    'The network connection was lost',
    'loading dynamically imported module',
    'Network request failed',
];

/**
 * undici's thrown `TypeError: fetch failed` carries the useful system code one or two `cause` levels
 * down, so the code check MUST walk the chain — but a self-referential chain would spin forever, so
 * the walk is depth-capped.
 */
const MAX_CAUSE_DEPTH = 5;

/**
 * Decides whether a thrown error is a transport reject and, if so, mints the typed {@link OfflineError}
 * for it. Stateless and dependency-free, so a caller can `new` it directly on the browser fetch path
 * (instance methods, not static — webpieces wires behaviour into injectable classes, and a static
 * method is just a module-scope function wearing a class as a namespace).
 */
export class NetworkRejectClassifier {
    /**
     * Classify an error as a transport reject ("the request never reached a server").
     *
     * Node/undici system codes are checked first (a stable code beats text), then browser wordings.
     */
    isNetworkRejectError(error: Error): boolean {
        return this.hasNodeSystemCode(error) || this.hasBrowserRejectMessage(error);
    }

    /**
     * If `error` is a transport reject, return an {@link OfflineError} that names `url` and preserves
     * the original as `cause`. Otherwise return `error` UNTOUCHED — a genuine bug keeps its own type
     * and stack, so a defect is never silently relabelled as "offline".
     */
    toNetworkError(error: Error, url: string): Error {
        if (this.isNetworkRejectError(error)) {
            return new OfflineError(`Request to ${url} never reached a server (offline / network reject)`, error);
        }
        return error;
    }

    /**
     * True if this error (or any error up its `cause` chain, to {@link MAX_CAUSE_DEPTH}) carries a
     * node/undici system code meaning the transport never delivered a response.
     */
    private hasNodeSystemCode(error: Error): boolean {
        let current: Error | undefined = error;
        for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current !== undefined; depth += 1) {
            const code = (current as CausedError).code;
            if (code !== undefined && NODE_SYSTEM_CODES.has(code)) {
                return true;
            }
            // Error.cause is `unknown`; only an Error carries the message/code we can read next, so a
            // non-Error cause (or none) ends the walk. undici's nested reject IS an Error, so this
            // still reaches the ECONNREFUSED it hangs one level down.
            current = current.cause instanceof Error ? current.cause : undefined;
        }
        return false;
    }

    /** True if the error message contains any known browser transport-reject wording. */
    private hasBrowserRejectMessage(error: Error): boolean {
        const message = error.message;
        return BROWSER_REJECT_MESSAGES.some((wording: string) => message.includes(wording));
    }
}
