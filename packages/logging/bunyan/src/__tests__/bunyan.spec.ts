import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { Writable } from 'stream';
import bunyan from 'bunyan';
import {
    ContextKey,
    GCP_LOG_BUDGET_BYTES,
    HeaderRegistry,
    LogChunkInfo,
    MAX_GCP_LOG_BYTES,
    ServiceInfo,
} from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import { BunyanLogger } from '../BunyanLogger';
import { BunyanConsoleFactory } from '../BunyanConsoleFactory';
import { ChunkingRawStream } from '../ChunkingRawStream';
import { LoggedError } from '../LoggedError';
import { logLevelToBunyanLevel } from '../levels';

const REQUEST_ID = new ContextKey('requestId', 'x-request-id');
// secured → masked in logs
const AUTH_TOKEN = new ContextKey('authToken', 'x-auth-token', true);
// routed-endpoint identity — rendered specially by the console line ([Controller.method]).
const CONTROLLER = new ContextKey('controller');
const METHOD = new ContextKey('method');

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
    HeaderRegistry.configure([REQUEST_ID, AUTH_TOKEN, CONTROLLER, METHOD], /*platformHeaders*/ false);
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
    // A log line with no active context (startup, a background job, or an unwrapped in-process call)
    // is legitimate: logging keeps working, just with no context fields — and there is NO extra
    // "missing filter" warning line (that vague, startup-tripped nudge was removed; the real misuse
    // is caught precisely by ApiClientFactory.requireActiveContext()).
    it('logs out-of-context lines with no context fields and no extra warning', async () => {
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

        // ...and nothing else: exactly the three lines, no "missing filter" report
        expect(h.lines.length).toBe(3);
        const reports = msgs.filter((m: string) => m.includes('OUTSIDE RequestContext.run'));
        expect(reports.length).toBe(0);
    });
});

describe('BunyanConsoleFactory', () => {
    // The factory no longer reads ServiceInfo (its bunyan root name is a fixed constant, and the
    // build version rides the per-record context map). We still set an identity here because the
    // context map stamps `version` from it on the lines these tests emit.
    beforeEach(() => {
        ServiceInfo.clear();
        ServiceInfo.setInfo('test-svc', '9.9.9');
    });

    afterEach(() => {
        ServiceInfo.clear();
        vi.restoreAllMocks();
    });

    it('does NOT throw when the service was never identified — logging works before setInfo', () => {
        ServiceInfo.clear();

        expect(() => new BunyanConsoleFactory()).not.toThrow();
    });

    it('writes a human-readable line with context tags', async () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const factory = new BunyanConsoleFactory();
        withContext(() => factory.getLogger('MyLogger').info('hello world'));
        await flush();

        const line = String(spy.mock.calls[0][0]);
        expect(line).toContain('[MyLogger]');
        expect(line).toContain('requestId:req-123');
        expect(line).toContain('authToken:sup...lue');
        expect(line).toContain('hello world');
    });

    /**
     * The build `version` rides every record (from the context map) — but LOCALLY it is noise: you
     * can check git yourself. The console renderer tags every NON-structural field, so `version` must
     * be listed as structural (BUNYAN_STD_FIELDS in ../streams) or it would ride every single line.
     * (The bunyan root `name` is a fixed constant now, also structural, so it never shows either.)
     */
    it('keeps version OUT of the local console line — noise you already know', async () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const factory = new BunyanConsoleFactory();
        withContext(() => factory.getLogger('MyLogger').info('hello world'));
        await flush();

        const line = String(spy.mock.calls[0][0]);
        expect(line).not.toContain('9.9.9');
        expect(line).not.toContain('version');
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
 * The version half of ServiceInfo exists so a log line can say WHICH BUILD emitted it. It now rides
 * every in-request record via the per-record context map (RequestContext.buildStructuredLogFields),
 * NOT as a factory base field — so it appears the moment setInfo has run, is absent before, and
 * logging keeps working either way. This is the field GCP filters on.
 */
describe('BunyanConsoleFactory local pretty line (trytami format)', () => {
    beforeEach(() => {
        ServiceInfo.clear();
        ServiceInfo.setInfo('test-svc', '9.9.9');
    });
    afterEach(() => {
        ServiceInfo.clear();
        vi.restoreAllMocks();
    });

    // Level FIRST, then time, then [Controller.method], then [loggerName], then key:value tags.
    // controller/method must NOT also render as key:value tags.
    it('renders [LEVEL][time][Controller.method][loggerName][tags]: msg — level first', async () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const factory = new BunyanConsoleFactory();
        RequestContext.run(() => {
            RequestContext.putHeader(REQUEST_ID, 'req-123');
            RequestContext.putHeader(CONTROLLER, 'LoginController');
            RequestContext.putHeader(METHOD, 'login');
            factory.getLogger('TokenService').info('hello world');
        });
        await flush();

        const line = String(spy.mock.calls[0][0]);
        expect(line).toMatch(
            /^\[INFO \]\[\d{2}:\d{2}:\d{2}\.\d{3}\]\[LoginController\.login\]\[TokenService\]\[/,
        );
        expect(line).toContain('requestId:req-123');
        expect(line).toContain('hello world');
        expect(line).not.toContain('controller:');
        expect(line).not.toContain('method:');
    });

    it('honors the console field allow-list (renders only requestId, hides authToken)', async () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const factory = new BunyanConsoleFactory(['requestId']);
        withContext(() => factory.getLogger('L').info('hi'));
        await flush();

        const line = String(spy.mock.calls[0][0]);
        expect(line).toContain('requestId:req-123');
        expect(line).not.toContain('authToken');
    });

    it('appends the multi-line Error Details block on error', async () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const factory = new BunyanConsoleFactory();
        withContext(() => factory.getLogger('L').error('boom', new Error('bad')));
        await flush();

        const line = String(spy.mock.calls[spy.mock.calls.length - 1][0]);
        expect(line).toContain('[ERROR]');
        expect(line).toContain('Error Details:');
        expect(line).toContain('Message: bad');
        expect(line).toContain('Name: Error');
        expect(line).toContain('Stack Trace:');
    });
});

describe('bunyan stamps the ServiceInfo build version on every in-request record', () => {
    afterEach(() => {
        ServiceInfo.clear();
    });

    it('adds `version` from ServiceInfo — present after setInfo', async () => {
        ServiceInfo.setInfo('billing-svc', 'v3.2.1-rc4');
        const h = new BunyanHarness();
        const log = new BunyanLogger(h.base.child({ loggerName: 'MyLogger' }));
        withContext(() => log.info('hello'));
        await flush();

        const rec = JSON.parse(h.lines[0]);
        expect(rec.version).toBe('v3.2.1-rc4');
    });

    it('omits `version` when the service is not identified — the line still emits', async () => {
        ServiceInfo.clear();
        const h = new BunyanHarness();
        const log = new BunyanLogger(h.base.child({ loggerName: 'MyLogger' }));
        withContext(() => log.info('hello'));
        await flush();

        const rec = JSON.parse(h.lines[0]);
        expect(rec.msg).toBe('hello');       // logging works before setInfo...
        expect(rec.version).toBeUndefined(); // ...just without a build id
    });

    /**
     * `version` must survive as its own field: bunyan uses `v` for its own log-format version, so the
     * build id must not land there. (bunyan also DELETES reserved option names stream/streams/level/
     * serializers/src from base fields — a future rename onto one of those would silently drop it.)
     */
    it('does not collide with a bunyan reserved field — `v` stays bunyan\'s format version', async () => {
        ServiceInfo.setInfo('billing-svc', 'v3.2.1-rc4');
        const h = new BunyanHarness();
        const log = new BunyanLogger(h.base.child({ loggerName: 'MyLogger' }));
        withContext(() => log.info('hello'));
        await flush();

        const rec = JSON.parse(h.lines[0]);
        expect(rec.v).toBe(0);
        expect(rec.version).toBe('v3.2.1-rc4');
    });
});

/** A bunyan record as a raw stream receives it. */
type RawRecord = Record<string, unknown>;

/** Stands in for the LoggingBunyan Writable, collecting the records that reach Cloud Logging. */
class RecordingTarget extends Writable {
    readonly records: RawRecord[] = [];
    constructor() {
        super({ objectMode: true });
    }
    override _write(record: RawRecord, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
        this.records.push(record);
        cb();
    }
}

/** A BunyanLogger writing through the real ChunkingRawStream into a RecordingTarget. */
class ChunkHarness {
    readonly target = new RecordingTarget();
    readonly log: BunyanLogger;
    constructor(budgetBytes: number) {
        const base = bunyan.createLogger({
            name: 'chunk-test',
            streams: [{ level: 'info', type: 'raw', stream: new ChunkingRawStream(this.target, budgetBytes) }],
        });
        this.log = new BunyanLogger(base);
    }
    chunkOf(record: RawRecord): LogChunkInfo {
        return record['logChunk'] as LogChunkInfo;
    }
}

describe('ChunkingRawStream — an oversized entry fails the whole entries.write call', () => {
    it('passes a within-budget record straight through, untagged', async () => {
        const h = new ChunkHarness(GCP_LOG_BUDGET_BYTES);
        withContext(() => h.log.info('small message'));
        await flush();

        expect(h.target.records.length).toBe(1);
        expect(h.target.records[0]['msg']).toBe('small message');
        expect(h.target.records[0]['logChunk']).toBeUndefined();
    });

    it('splits an oversized msg and reassembles byte-exactly', async () => {
        const message = `response=${JSON.stringify({ blob: 'x'.repeat(20_000) })}`;
        const h = new ChunkHarness(4096);
        withContext(() => h.log.info(message));
        await flush();

        const records = h.target.records;
        expect(records.length).toBeGreaterThan(1);

        const uids = new Set(records.map((r: RawRecord) => h.chunkOf(r).uid));
        expect(uids.size).toBe(1);
        records.forEach((rec: RawRecord, i: number) => {
            expect(h.chunkOf(rec).index).toBe(i);
            expect(h.chunkOf(rec).total).toBe(records.length);
        });

        expect(records.map((r: RawRecord) => r['msg'] as string).join('')).toBe(message);
        // Every piece keeps the context, or it could not be correlated in Cloud Logging.
        for (const rec of records) {
            expect(rec['requestId']).toBe('req-123');
            expect(rec['authToken']).toBe('sup...lue');
        }
    });

    it('keeps a giant stack WHOLE across pieces — it is no longer truncated to 5 frames', async () => {
        const err = new Error('boom');
        const frames = '    at someFrame (/a/b/c.ts:1:1)\n'.repeat(4000);
        err.stack = `Error: boom\n${frames}`;

        const h = new ChunkHarness(8192);
        withContext(() => h.log.error('failed', err));
        await flush();

        const records = h.target.records;
        expect(records.length).toBeGreaterThan(1);

        const rebuilt = records.map((r: RawRecord) => (r['err'] as LoggedError).stack ?? '').join('');
        expect(rebuilt).toBe(err.stack);
        // The old guard replaced the name with "error too long: Error" and cut the message to 100
        // chars. Both must be intact now.
        for (const rec of records) {
            expect((rec['err'] as LoggedError).name).toBe('Error');
            expect((rec['err'] as LoggedError).message).toBe('boom');
        }
    });

    it('holds every piece under the real GCP budget for a 600KB body', async () => {
        const h = new ChunkHarness(GCP_LOG_BUDGET_BYTES);
        withContext(() => h.log.info(`response=${JSON.stringify({ blob: 'q'.repeat(600_000) })}`));
        await flush();

        expect(h.target.records.length).toBeGreaterThan(1);
        for (const rec of h.target.records) {
            const bytes = new TextEncoder().encode(JSON.stringify(rec)).length;
            expect(bytes).toBeLessThanOrEqual(GCP_LOG_BUDGET_BYTES);
            expect(bytes).toBeLessThan(MAX_GCP_LOG_BYTES);
        }
    });
});
