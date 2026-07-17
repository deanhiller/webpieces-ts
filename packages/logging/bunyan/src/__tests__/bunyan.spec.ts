import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { Writable } from 'stream';
import bunyan from 'bunyan';
import { ContextKey, HeaderRegistry, ServiceInfo } from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import { BunyanLogger } from '../BunyanLogger';
import { BunyanConsoleFactory } from '../BunyanConsoleFactory';
import { logLevelToBunyanLevel } from '../levels';

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

// A bunyan logger whose stream records the raw JSON lines.
class BunyanHarness {
    readonly lines: string[] = [];
    readonly base: bunyan;
    constructor() {
        const lines = this.lines;
        const stream = new Writable({
            write(chunk: Buffer | string, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
                lines.push(chunk.toString());
                cb();
            },
        });
        this.base = bunyan.createLogger({ name: 'test', level: 'trace', streams: [{ stream }] });
    }
}

beforeAll(() => {
    HeaderRegistry.configure([REQUEST_ID, AUTH_TOKEN], /*platformHeaders*/ false);
});

async function flush(): Promise<void> {
    await new Promise<void>((resolve: () => void) => setImmediate(resolve));
}

describe('levels', () => {
    it('maps webpieces levels onto bunyan numeric levels', () => {
        expect(logLevelToBunyanLevel('trace')).toBe(bunyan.TRACE);
        expect(logLevelToBunyanLevel('info')).toBe(bunyan.INFO);
        expect(logLevelToBunyanLevel('error')).toBe(bunyan.ERROR);
    });
});

describe('BunyanLogger context enrichment', () => {
    it('merges masked context fields into every record', async () => {
        const h = new BunyanHarness();
        const log = new BunyanLogger(h.base);
        withContext(() => log.info('hi'));
        await flush();

        const rec = JSON.parse(h.lines[0]);
        expect(rec.msg).toBe('hi');
        expect(rec.level).toBe(bunyan.INFO);
        expect(rec.requestId).toBe('req-123');
        expect(rec.authToken).toBe('sup...lue');
    });

    it('normalizes an Error into err { name, message, stack }', async () => {
        const h = new BunyanHarness();
        const log = new BunyanLogger(h.base);
        withContext(() => log.error('boom', new Error('bad')));
        await flush();

        const rec = JSON.parse(h.lines[h.lines.length - 1]);
        expect(rec.level).toBe(bunyan.ERROR);
        expect(rec.err.name).toBe('Error');
        expect(rec.err.message).toBe('bad');
        expect(typeof rec.err.stack).toBe('string');
    });
});

describe('logging outside RequestContext.run', () => {
    // A log line with no active context = a missing request-wrapping server filter.
    // BunyanLogger reports it ONCE (via the raw bunyan logger, so no re-entrancy)
    // and never spins, even across many out-of-context lines.
    it('reports the missing filter exactly once and never infinite-loops', async () => {
        const h = new BunyanHarness();
        const log = new BunyanLogger(h.base);

        // three lines, all OUTSIDE any RequestContext.run(...)
        log.info('no-ctx-1');
        log.error('no-ctx-2', new Error('boom'));
        log.info('no-ctx-3');
        await flush();

        // the three lines still emit (logging keeps working, just without context)...
        const msgs = h.lines.map((l: string) => JSON.parse(l).msg as string);
        expect(msgs).toContain('no-ctx-1');
        expect(msgs).toContain('no-ctx-2');
        expect(msgs).toContain('no-ctx-3');

        // ...plus exactly ONE "missing filter" report across all three
        const reports = msgs.filter((m: string) => m.includes('OUTSIDE RequestContext.run'));
        expect(reports.length).toBe(1);
    });
});

describe('BunyanConsoleFactory', () => {
    // The factory reads its (bunyan-mandatory) root-logger name + the version from ServiceInfo, so
    // identify the service first — exactly as a real startup does, before constructing the factory.
    beforeEach(() => {
        ServiceInfo.clear();
        ServiceInfo.setInfo('test-svc', '9.9.9');
    });

    afterEach(() => {
        ServiceInfo.clear();
        vi.restoreAllMocks();
    });

    it('FAILS FAST when the service was never identified — at construction, i.e. at startup', () => {
        ServiceInfo.clear();

        expect(() => new BunyanConsoleFactory()).toThrow(/ServiceInfo\.setInfo\(\.\.\.\) has not been called/);
    });

    it('writes a human-readable line with context tags', async () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const factory = new BunyanConsoleFactory();
        withContext(() => factory.getLogger('MyLogger').info('hello world'));
        await flush();

        const line = String(spy.mock.calls[0][0]);
        expect(line).toContain('logger:MyLogger');
        expect(line).toContain('requestId:req-123');
        expect(line).toContain('authToken:sup...lue');
        expect(line).toContain('hello world');
    });

    /**
     * The service name + build version are ServiceInfo base fields on every record — but LOCALLY
     * they are noise: you know which service you just started, and you can check git yourself. The
     * console renderer tags every NON-structural field, so both must be listed as structural
     * (BUNYAN_STD_FIELDS in ../streams) or they would ride along on every single line.
     */
    it('keeps svcName + version OUT of the local console line — noise you already know', async () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const factory = new BunyanConsoleFactory();
        withContext(() => factory.getLogger('MyLogger').info('hello world'));
        await flush();

        const line = String(spy.mock.calls[0][0]);
        expect(line).not.toContain('9.9.9');
        expect(line).not.toContain('version');
        expect(line).not.toContain('test-svc');
        // ...while the per-request tag that IS worth reading locally still renders.
        expect(line).toContain('requestId:req-123');
    });

    it('caches one Logger per name', () => {
        const factory = new BunyanConsoleFactory();
        expect(factory.getLogger('X')).toBe(factory.getLogger('X'));
        expect(factory.getLogger('X')).not.toBe(factory.getLogger('Y'));
    });
});

/**
 * The version half of ServiceInfo exists so a log line can say WHICH BUILD emitted it. bunyan could
 * not stamp one at all before (it lived on winston's factory options), so this pins that it now
 * rides on the record itself — the thing GCP filters on.
 */
describe('bunyan stamps the ServiceInfo identity on every record', () => {
    afterEach(() => {
        ServiceInfo.clear();
    });

    it('puts svcName on `name` and the build version on `version`', () => {
        ServiceInfo.clear();
        ServiceInfo.setInfo('billing-svc', 'v3.2.1-rc4');

        const lines: string[] = [];
        const stream = new Writable({
            write(chunk: Buffer | string, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
                lines.push(chunk.toString());
                cb();
            },
        });
        // Build the root logger exactly as BunyanFactoryBase does, against a capturing stream.
        const base = bunyan.createLogger({
            name: ServiceInfo.getName(),
            version: ServiceInfo.getVersion(),
            streams: [{ stream }],
        });
        new BunyanLogger(base.child({ loggerName: 'MyLogger' })).info('hello');

        const rec = JSON.parse(lines[0]);
        expect(rec.name).toBe('billing-svc');
        expect(rec.version).toBe('v3.2.1-rc4');
    });

    /**
     * `version` must survive as its own field: bunyan DELETES a handful of reserved option names
     * (stream/streams/level/serializers/src) from base fields, and uses `v` for its own log-format
     * version. A future rename onto one of those would silently drop the build id.
     */
    it('does not collide with a bunyan reserved field — `v` stays bunyan\'s format version', () => {
        ServiceInfo.clear();
        ServiceInfo.setInfo('billing-svc', 'v3.2.1-rc4');

        const lines: string[] = [];
        const stream = new Writable({
            write(chunk: Buffer | string, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
                lines.push(chunk.toString());
                cb();
            },
        });
        const base = bunyan.createLogger({
            name: ServiceInfo.getName(),
            version: ServiceInfo.getVersion(),
            streams: [{ stream }],
        });
        base.info('hello');

        const rec = JSON.parse(lines[0]);
        expect(rec.v).toBe(0);
        expect(rec.version).toBe('v3.2.1-rc4');
    });
});
