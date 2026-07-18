import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Writable } from 'stream';
import { createLogger, format, transports } from 'winston';
import type { Logger as WinstonBase } from 'winston';
import {
    ContextKey,
    GCP_LOG_BUDGET_BYTES,
    HeaderRegistry,
    LogChunkInfo,
    MAX_GCP_LOG_BYTES,
    ServiceInfo,
} from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import { WinstonLogger } from '../WinstonLogger';
import { WinstonConsoleFactory } from '../WinstonConsoleFactory';
import { WinstonGcpFactory } from '../WinstonGcpFactory';
import { ChunkingConsoleTransport } from '../ChunkingConsoleTransport';
import { bigIntSafeFormat, injectContextFormat, severityFormat } from '../format';

const REQUEST_ID = new ContextKey('requestId', 'x-request-id');
// secured → masked in logs
const AUTH_TOKEN = new ContextKey('authToken', 'x-auth-token', true);

// Run `fn` inside a RequestContext carrying the canned context values the loggers
// read directly (requestId + a long secured authToken that masks to "sup...lue").
function withContext(fn: () => void): void {
    RequestContext.run(() => {
        RequestContext.putHeader(REQUEST_ID, 'req-123');
        // length 20 (> 15) → masked to first3 + "..." + last3 = "sup...lue"
        RequestContext.putHeader(AUTH_TOKEN, 'supersecretlongvalue');
        fn();
    });
}

// A logger wired with the exact WinstonGcpFactory format stack, capturing its
// JSON output lines instead of writing to stdout.
class GcpHarness {
    readonly lines: string[] = [];
    readonly raw: WinstonBase;
    readonly log: WinstonLogger;
    constructor() {
        const lines = this.lines;
        const stream = new Writable({
            write(chunk: Buffer | string, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
                lines.push(chunk.toString());
                cb();
            },
        });
        this.raw = createLogger({
            level: 'silly',
            format: format.combine(
                bigIntSafeFormat(),
                injectContextFormat(),
                severityFormat(),
                format.json(),
            ),
            transports: [new transports.Stream({ stream })],
        });
        this.log = new WinstonLogger(this.raw);
    }
}

beforeAll(() => {
    HeaderRegistry.configure([REQUEST_ID, AUTH_TOKEN], /*platformHeaders*/ false);
});

async function flush(): Promise<void> {
    await new Promise<void>((resolve: () => void) => setImmediate(resolve));
}

/**
 * Capture what the REAL factories emit, so a test sees the same bytes an operator would.
 *
 * winston's Console transport writes to `console._stdout` when that exists, else to a `console.log`
 * it BOUND IN ITS OWN CONSTRUCTOR. Node points `console._stdout` at process.stdout; under vitest,
 * console is a replacement whose `_stdout` is vitest's own stream — so spying process.stdout catches
 * nothing here. Hook whichever sink this console exposes, and do it BEFORE `build()` runs, since the
 * transport binds its fallback at construction.
 */
async function captureStdout(build: () => void): Promise<string> {
    const out: string[] = [];
    const push = (chunk: string | Uint8Array): boolean => {
        out.push(chunk.toString());
        return true;
    };

    const stdout = (console as unknown as { _stdout?: NodeJS.WritableStream })._stdout;
    const sinkSpy = stdout
        ? vi.spyOn(stdout, 'write').mockImplementation(push)
        : vi.spyOn(process.stdout, 'write').mockImplementation(push);
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]): void => {
        out.push(args.map((a: unknown) => String(a)).join(' '));
    });

    build();
    await flush();

    sinkSpy.mockRestore();
    logSpy.mockRestore();
    return out.join('');
}

describe('winston GCP format stack', () => {
    it('maps level → GCP severity and injects context fields (masking secured)', async () => {
        const h = new GcpHarness();
        withContext(() => h.log.warn('hi'));
        await flush();

        const rec = JSON.parse(h.lines[0]);
        expect(rec.severity).toBe('WARNING');
        expect(rec.message).toBe('hi');
        expect(rec.requestId).toBe('req-123');
        expect(rec.authToken).toBe('sup...lue');
    });

    it('trace maps to DEBUG severity; error maps to ERROR and spreads the Error', async () => {
        const h = new GcpHarness();
        withContext(() => {
            h.log.trace('finest');
            h.log.error('boom', new Error('bad'));
        });
        await flush();

        const traceRec = JSON.parse(h.lines[0]);
        expect(traceRec.severity).toBe('DEBUG');

        const errRec = JSON.parse(h.lines[1]);
        expect(errRec.severity).toBe('ERROR');
        expect(errRec.errName).toBe('Error');
        expect(errRec.errMessage).toBe('bad');
        expect(typeof errRec.errStack).toBe('string');
    });

    it('serializes bigint safely (no crash)', async () => {
        const h = new GcpHarness();
        withContext(() => h.raw.info('big', { count: BigInt(10) }));
        await flush();

        const rec = JSON.parse(h.lines[0]);
        expect(rec.count).toBe('10');
    });
});

describe('winston factories', () => {
    // The factory reads svcName from ServiceInfo at construction (a defaultMeta base field); the build
    // `version` rides the per-record context map instead. We identify the service first so both appear
    // on the lines these tests emit.
    beforeEach(() => {
        ServiceInfo.clear();
        ServiceInfo.setInfo('test-svc', '9.9.9');
    });

    afterEach(() => {
        ServiceInfo.clear();
    });

    it('does NOT throw when the service was never identified — logging works before setInfo', () => {
        ServiceInfo.clear();

        expect(() => new WinstonConsoleFactory()).not.toThrow();
    });

    it('WinstonConsoleFactory caches one Logger per name', () => {
        const factory = new WinstonConsoleFactory();
        expect(factory.getLogger('A')).toBe(factory.getLogger('A'));
        expect(factory.getLogger('A')).not.toBe(factory.getLogger('B'));
        expect(typeof factory.getLogger('A').info).toBe('function');
    });

    it('WinstonGcpFactory hands out webpieces Loggers', () => {
        const factory = new WinstonGcpFactory();
        expect(typeof factory.getLogger('C').error).toBe('function');
    });

    /**
     * The point of the ServiceInfo identity: a GCP line must say WHICH SERVICE and WHICH BUILD
     * emitted it, so you can filter jsonPayload.svcName / jsonPayload.version across a fleet and a
     * rollout. `svcName` is a factory defaultMeta base field; `version` rides the per-request context
     * map, so this asserts it on an in-request line (the normal case).
     */
    it('WinstonGcpFactory stamps svcName + version on every in-request JSON line', async () => {
        const written = await captureStdout(() => {
            withContext(() => new WinstonGcpFactory().getLogger('MyLogger').info('hello'));
        });

        const rec = JSON.parse(written);
        expect(rec.svcName).toBe('test-svc');
        expect(rec.version).toBe('9.9.9');
    });

    /**
     * LOCALLY both are noise: you know which service you just started, and you can check git
     * yourself. They must not render in the bracket prefix NOR fall through to the trailing JSON
     * blob — the latter is what happens to any defaultMeta field missing from LOCAL_STRUCTURAL_KEYS
     * (as svcName itself did when it was first added).
     */
    it('WinstonConsoleFactory keeps svcName + version OUT of the local line', async () => {
        const line = await captureStdout(() => {
            withContext(() => new WinstonConsoleFactory().getLogger('MyLogger').info('hello'));
        });

        expect(line).not.toContain('test-svc');
        expect(line).not.toContain('9.9.9');
        expect(line).not.toContain('svcName');
        expect(line).not.toContain('version');
        // ...while the per-request key that IS worth reading locally still renders.
        expect(line).toContain('requestId=req-123');
    });
});

/** One parsed GCP log line. Values are whatever JSON holds. */
type LogRecord = Record<string, unknown>;

const chunkOf = (rec: LogRecord): LogChunkInfo => rec['logChunk'] as LogChunkInfo;

/**
 * A logger wired with the GCP format stack writing through the real ChunkingConsoleTransport.
 * The transport extends Console (which writes to stdout), so we capture stdout rather than
 * injecting a stream — that keeps the REAL transport under test instead of a stand-in.
 */
class ChunkHarness {
    readonly lines: string[] = [];
    readonly log: WinstonLogger;
    private readonly restore: () => void;

    constructor(budgetBytes: number) {
        const lines = this.lines;
        // winston's Console transport writes to `console._stdout` when it exists — which under vitest
        // is NOT process.stdout — so patch the stream the transport actually reaches for.
        const sink = (console as unknown as { _stdout: NodeJS.WriteStream })._stdout;
        const original = sink.write;
        sink.write = ((chunk: string | Uint8Array): boolean => {
            lines.push(String(chunk).trimEnd());
            return true;
        }) as typeof sink.write;
        this.restore = (): void => {
            sink.write = original;
        };

        const raw = createLogger({
            level: 'silly',
            format: format.combine(bigIntSafeFormat(), injectContextFormat(), severityFormat(), format.json()),
            defaultMeta: { svcName: 'chunk-test' },
            transports: [new ChunkingConsoleTransport(budgetBytes)],
        });
        this.log = new WinstonLogger(raw);
    }

    stop(): void {
        this.restore();
    }

    records(): LogRecord[] {
        return this.lines.map((line: string) => JSON.parse(line));
    }
}

describe('ChunkingConsoleTransport — GCP silently DROPS oversized jsonPayload entries', () => {
    it('leaves a within-budget record alone: one line, no logChunk tag', async () => {
        const h = new ChunkHarness(GCP_LOG_BUDGET_BYTES);
        withContext(() => h.log.info('small message'));
        await flush();
        h.stop();

        expect(h.lines.length).toBe(1);
        const rec = h.records()[0];
        expect(rec['message']).toBe('small message');
        expect(rec['logChunk']).toBeUndefined();
        expect(rec['requestId']).toBe('req-123');
    });

    it('splits an oversized message into COMPLETE records that each parse as JSON', async () => {
        const budget = 4096;
        const body = JSON.stringify({ blob: 'x'.repeat(20_000) });
        const message = `[API-server-resp-SUCCESS] SaveApi.save response=${body}`;

        const h = new ChunkHarness(budget);
        withContext(() => h.log.info(message));
        await flush();
        h.stop();

        expect(h.lines.length).toBeGreaterThan(1);
        // The whole point: a sliced JSON line would be unparseable and land as textPayload.
        for (const line of h.lines) {
            expect(() => JSON.parse(line)).not.toThrow();
            expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(budget);
        }
    });

    it('reassembles byte-exactly: sort by logChunk.index, concat message', async () => {
        const message = `payload=${JSON.stringify({ blob: 'y'.repeat(20_000) })}`;
        const h = new ChunkHarness(4096);
        withContext(() => h.log.info(message));
        await flush();
        h.stop();

        const records = h.records();
        const uids = new Set(records.map((r: LogRecord) => chunkOf(r).uid));
        expect(uids.size).toBe(1); // one message → one uid to grep

        const total = records.length;
        records.forEach((rec: LogRecord, i: number) => {
            expect(chunkOf(rec).index).toBe(i);
            expect(chunkOf(rec).total).toBe(total);
        });

        const rebuilt = records
            .slice()
            .sort((a: LogRecord, b: LogRecord) => chunkOf(a).index - chunkOf(b).index)
            .map((r: LogRecord) => r['message'] as string)
            .join('');
        expect(rebuilt).toBe(message);
    });

});

describe('ChunkingConsoleTransport — each piece must stand on its own', () => {
    it('keeps the envelope on EVERY piece, so a chunk is never orphaned', async () => {
        const h = new ChunkHarness(4096);
        withContext(() => h.log.warn(`big=${'z'.repeat(20_000)}`));
        await flush();
        h.stop();

        // Guard the loop below: with zero records it would assert nothing and pass vacuously.
        expect(h.records().length).toBeGreaterThan(1);
        // Without these, a piece could not be correlated or filtered in Cloud Logging.
        for (const rec of h.records()) {
            expect(rec['requestId']).toBe('req-123');
            expect(rec['severity']).toBe('WARNING');
            expect(rec['svcName']).toBe('chunk-test');
            expect(rec['authToken']).toBe('sup...lue'); // secured value stays masked on every piece
        }
    });

    it('splits a giant STACK TRACE instead of truncating it — the stack is why you opened the logs', async () => {
        const err = new Error('boom');
        err.stack = `Error: boom\n${'    at someFrame (/a/b/c.ts:1:1)\n'.repeat(1000)}`;

        const h = new ChunkHarness(4096);
        withContext(() => h.log.error('failed', err));
        await flush();
        h.stop();

        const records = h.records();
        expect(records.length).toBeGreaterThan(1);
        const rebuilt = records.map((r: LogRecord) => (r['errStack'] as string) ?? '').join('');
        expect(rebuilt).toBe(err.stack); // every frame survives
        for (const rec of records) {
            expect(rec['errName']).toBe('Error');
            expect(rec['errMessage']).toBe('boom');
        }
    });

    it('holds each record under the REAL GCP ceiling for a 600KB body', async () => {
        const h = new ChunkHarness(GCP_LOG_BUDGET_BYTES);
        withContext(() => h.log.info(`response=${JSON.stringify({ blob: 'q'.repeat(600_000) })}`));
        await flush();
        h.stop();

        expect(h.lines.length).toBeGreaterThan(1);
        for (const line of h.lines) {
            const bytes = new TextEncoder().encode(line).length;
            expect(bytes).toBeLessThanOrEqual(GCP_LOG_BUDGET_BYTES);
            // The limit that actually drops entries — the budget exists to stay well clear of it.
            expect(bytes).toBeLessThan(MAX_GCP_LOG_BYTES);
        }
    });
});
