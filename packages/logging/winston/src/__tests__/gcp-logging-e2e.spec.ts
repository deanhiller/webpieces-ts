import { describe, it, expect, beforeAll } from 'vitest';
import {
    ApiCallContextHolder,
    ApiMethodInfo,
    ContextKey,
    HeaderRegistry,
    LogApiCall,
    LogManager,
    MAX_GCP_LOG_BYTES,
    ServiceInfo,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import { RequestContext, RequestContextApiCallContext } from '@webpieces/core-context';
import { WinstonGcpFactory } from '../WinstonGcpFactory';

/**
 * End-to-end, with NOTHING stubbed: a real LogApiCall inside a real RequestContext, logging through a
 * real WinstonGcpFactory (real format stack, real ChunkingConsoleTransport), asserting on the actual
 * stdout the Cloud Run logging agent would ingest.
 *
 * WHY THIS EXISTS on top of the unit tests: the two halves of GCP api-logging are built at opposite
 * ends of the stack and only meet here. LogApiCall (core-util) reports durationMs/sizes into the `api`
 * tag; the transport (this package) splits oversized records. Each is unit-tested alone, and both
 * could pass while the composition is broken — e.g. the `api` tag lost on chunk 2, or the message
 * chunked into unparseable lines. This test fails if the SHIPPED behaviour regresses.
 */

const REQUEST_ID = new ContextKey('requestId', 'x-request-id');

/** One parsed line of stdout, exactly as the logging agent would receive it. */
type LogRecord = Record<string, unknown>;

/** Capture the stdout winston's Console transport writes to (not process.stdout under vitest). */
class StdoutCapture {
    readonly lines: string[] = [];
    private readonly sink = (console as unknown as { _stdout: NodeJS.WriteStream })._stdout;
    private readonly original = (console as unknown as { _stdout: NodeJS.WriteStream })._stdout.write;

    start(): void {
        const lines = this.lines;
        this.sink.write = ((chunk: string | Uint8Array): boolean => {
            lines.push(String(chunk).trimEnd());
            return true;
        }) as typeof this.sink.write;
    }
    stop(): void {
        this.sink.write = this.original;
    }
    records(): LogRecord[] {
        return this.lines.map((line: string) => JSON.parse(line));
    }
}

beforeAll(() => {
    // The api tag must be registered+logged, or it never reaches jsonPayload at all.
    HeaderRegistry.configure([REQUEST_ID, WebpiecesCoreHeaders.API_CALL_INFO], /*platformHeaders*/ false);
    ServiceInfo.setInfo('e2e-svc', '1.0.0-e2e');
    ApiCallContextHolder.install(new RequestContextApiCallContext());
    LogManager.setFactory(new WinstonGcpFactory());
});

/** Run one real API call returning `response`, capturing every line it logs. */
async function logApiCall(response: object, delayMs: number): Promise<LogRecord[]> {
    const capture = new StdoutCapture();
    capture.start();
    await RequestContext.run(async () => {
        RequestContext.putHeader(REQUEST_ID, 'req-e2e');
        await LogApiCall.execute(
            new ApiMethodInfo('server', 'SaveApi', 'save', 'SaveController'),
            { q: 'x' },
            async () => {
                await new Promise((resolve: () => void) => setTimeout(resolve, delayMs));
                return response;
            },
        );
    });
    capture.stop();
    return capture.records();
}

const apiTagOf = (rec: LogRecord): LogRecord => rec['api'] as LogRecord;
const responsesIn = (recs: LogRecord[]): LogRecord[] =>
    recs.filter((r: LogRecord) => apiTagOf(r)?.['type'] === 'response');

describe('E2E: a normal-sized API call', () => {
    it('emits one request + one response line carrying durationMs and both sizes', async () => {
        const recs = await logApiCall({ ok: true }, 20);

        expect(recs.length).toBe(2);
        expect(recs.every((r: LogRecord) => r['logChunk'] === undefined)).toBe(true); // nothing to split

        const api = apiTagOf(responsesIn(recs)[0]);
        expect(api['durationMs']).toBeGreaterThanOrEqual(15);
        expect(api['result']).toBe('success');
        expect(api['requestSize']).toBe(new TextEncoder().encode(JSON.stringify({ q: 'x' })).length);
        expect(api['responseSize']).toBe(new TextEncoder().encode(JSON.stringify({ ok: true })).length);
        // No statusCode: business logic does not know about HTTP.
        expect(api['statusCode']).toBeUndefined();
    });
});

describe('E2E: an API call whose response would be DROPPED by GCP', () => {
    it('splits the 400KB body into parseable records that reassemble, keeping the api tag', async () => {
        const big = { blob: 'w'.repeat(400_000) };
        const recs = await logApiCall(big, 20);
        const responses = responsesIn(recs);

        // Before chunking this was ONE ~400KB line — silently dropped, never seen again.
        expect(responses.length).toBeGreaterThan(1);

        // Every piece stays under the ceiling that drops entries, and stays correlatable.
        const uids = new Set(responses.map((r: LogRecord) => (r['logChunk'] as { uid: string }).uid));
        expect(uids.size).toBe(1);
        for (const rec of responses) {
            expect(new TextEncoder().encode(JSON.stringify(rec)).length).toBeLessThan(MAX_GCP_LOG_BYTES);
            expect(rec['requestId']).toBe('req-e2e');
            expect(rec['severity']).toBe('INFO');
            expect(apiTagOf(rec)['method']).toMatchObject({ apiClass: 'SaveApi', methodName: 'save' });
        }

        // The body survives in full, and the size reported is the TOTAL, not a chunk's.
        expect(responses.map((r: LogRecord) => r['message'] as string).join('')).toContain(JSON.stringify(big));
        expect(apiTagOf(responses[0])['responseSize']).toBeGreaterThan(400_000);
    });
});
