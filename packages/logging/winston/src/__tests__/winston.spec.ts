import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Writable } from 'stream';
import { createLogger, format, transports } from 'winston';
import type { Logger as WinstonBase } from 'winston';
import { ContextKey, HeaderRegistry, ServiceInfo } from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import { WinstonLogger } from '../WinstonLogger';
import { WinstonConsoleFactory } from '../WinstonConsoleFactory';
import { WinstonGcpFactory } from '../WinstonGcpFactory';
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
    // Both factories read the service name + version from ServiceInfo in their constructor, so
    // identify the service first — exactly as a real startup does.
    beforeEach(() => {
        ServiceInfo.clear();
        ServiceInfo.setInfo('test-svc', '9.9.9');
    });

    afterEach(() => {
        ServiceInfo.clear();
    });

    it('FAILS FAST when the service was never identified — at construction, i.e. at startup', () => {
        ServiceInfo.clear();

        expect(() => new WinstonConsoleFactory()).toThrow(/ServiceInfo\.setInfo\(\.\.\.\) has not been called/);
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
     * rollout. The version field used to be `svcGitHash` (winston-only, optional, and presuming a
     * git SHA); this pins the rename and the new required-ness.
     */
    it('WinstonGcpFactory stamps svcName + version on every JSON line', async () => {
        const written = await captureStdout(() => {
            new WinstonGcpFactory().getLogger('MyLogger').info('hello');
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
