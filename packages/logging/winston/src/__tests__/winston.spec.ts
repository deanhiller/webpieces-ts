import { describe, it, expect, beforeAll } from 'vitest';
import { Writable } from 'stream';
import { createLogger, format, transports } from 'winston';
import type { Logger as WinstonBase } from 'winston';
import { ContextKey, HeaderRegistry } from '@webpieces/core-util';
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
    HeaderRegistry.configure([REQUEST_ID, AUTH_TOKEN], [], /*platformHeaders*/ false);
});

async function flush(): Promise<void> {
    await new Promise<void>((resolve: () => void) => setImmediate(resolve));
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
});
