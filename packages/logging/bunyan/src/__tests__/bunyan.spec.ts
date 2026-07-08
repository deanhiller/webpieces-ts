import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { Writable } from 'stream';
import bunyan from 'bunyan';
import { ContextKey, HeaderRegistry } from '@webpieces/core-util';
import type { ContextReader } from '@webpieces/core-util';
import { BunyanLogger } from '../BunyanLogger';
import { BunyanConsoleFactory } from '../BunyanConsoleFactory';
import { logLevelToBunyanLevel } from '../levels';

const REQUEST_ID = new ContextKey('requestId', 'x-request-id');
// secured → masked in logs
const AUTH_TOKEN = new ContextKey('authToken', 'x-auth-token', true);

class FakeReader implements ContextReader {
    constructor(private readonly values: Map<string, string>) {}
    read(key: ContextKey): string | undefined {
        return this.values.get(key.name);
    }
}

const reader = new FakeReader(
    new Map([
        ['requestId', 'req-123'],
        // length 20 (> 15) → masked to "sup...lue"
        ['authToken', 'supersecretlongvalue'],
    ]),
);

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
    HeaderRegistry.configure([REQUEST_ID, AUTH_TOKEN], [], /*platformHeaders*/ false);
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
        const log = new BunyanLogger(h.base, reader);
        log.info('hi');
        await flush();

        const rec = JSON.parse(h.lines[0]);
        expect(rec.msg).toBe('hi');
        expect(rec.level).toBe(bunyan.INFO);
        expect(rec.requestId).toBe('req-123');
        expect(rec.authToken).toBe('sup...lue');
    });

    it('normalizes an Error into err { name, message, stack }', async () => {
        const h = new BunyanHarness();
        const log = new BunyanLogger(h.base, reader);
        log.error('boom', new Error('bad'));
        await flush();

        const rec = JSON.parse(h.lines[h.lines.length - 1]);
        expect(rec.level).toBe(bunyan.ERROR);
        expect(rec.err.name).toBe('Error');
        expect(rec.err.message).toBe('bad');
        expect(typeof rec.err.stack).toBe('string');
    });
});

describe('BunyanConsoleFactory', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('writes a human-readable line with context tags', async () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const factory = new BunyanConsoleFactory(reader);
        factory.getLogger('MyLogger').info('hello world');
        await flush();

        const line = String(spy.mock.calls[0][0]);
        expect(line).toContain('logger:MyLogger');
        expect(line).toContain('requestId:req-123');
        expect(line).toContain('authToken:sup...lue');
        expect(line).toContain('hello world');
    });

    it('caches one Logger per name', () => {
        const factory = new BunyanConsoleFactory(reader);
        expect(factory.getLogger('X')).toBe(factory.getLogger('X'));
        expect(factory.getLogger('X')).not.toBe(factory.getLogger('Y'));
    });
});
