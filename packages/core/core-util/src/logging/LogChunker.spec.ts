import { describe, expect, it } from 'vitest';
import { GCP_LOG_BUDGET_BYTES, LogChunker, MAX_GCP_LOG_BYTES } from './LogChunker';

/** The real cost of a string once it is a JSON string value — what the chunker must predict. */
const actualEscapedBytes = (text: string): number => {
    const serialized = JSON.stringify(text);
    // Strip the surrounding quotes JSON.stringify adds; we measure the escaped CONTENT.
    return new TextEncoder().encode(serialized.slice(1, -1)).length;
};

describe('LogChunker budget constants', () => {
    it('uses 256 KiB (262,144), not the 256,000 client libraries hardcode', () => {
        expect(MAX_GCP_LOG_BYTES).toBe(262_144);
    });

    it('budgets 75% of the limit, leaving headroom for the envelope + GCP internal sizing', () => {
        expect(GCP_LOG_BUDGET_BYTES).toBe(MAX_GCP_LOG_BYTES * 0.75);
        expect(GCP_LOG_BUDGET_BYTES).toBe(196_608);
    });
});

describe('LogChunker.escapedByteLength', () => {
    it('matches what JSON.stringify actually produces for plain ASCII', () => {
        const text = 'hello world';
        expect(LogChunker.escapedByteLength(text)).toBe(actualEscapedBytes(text));
        expect(LogChunker.escapedByteLength(text)).toBe(11);
    });

    it('counts the SECOND escaping of a JSON body — the bug that raw byte-length would miss', () => {
        // This is the LogApiCall case: a stringified DTO embedded in a message, escaped again.
        const body = JSON.stringify({ name: 'a', value: 'b' });
        expect(LogChunker.escapedByteLength(body)).toBe(actualEscapedBytes(body));
        // Every quote doubles: raw is shorter than escaped, which is the whole point.
        expect(LogChunker.escapedByteLength(body)).toBeGreaterThan(new TextEncoder().encode(body).length);
    });

    it('charges 6 bytes for a control character (\\u00XX) and 2 for a newline', () => {
        expect(LogChunker.escapedByteLength('')).toBe(6);
        expect(LogChunker.escapedByteLength('\n')).toBe(2);
        expect(LogChunker.escapedByteLength('')).toBe(actualEscapedBytes(''));
    });

    it('charges real UTF-8 width for multibyte text', () => {
        expect(LogChunker.escapedByteLength('é')).toBe(2);
        expect(LogChunker.escapedByteLength('日')).toBe(3);
        expect(LogChunker.escapedByteLength('😀')).toBe(4);
        expect(LogChunker.escapedByteLength('日本語')).toBe(actualEscapedBytes('日本語'));
    });
});

describe('LogChunker.chunk', () => {
    it('returns the text untouched when it already fits', () => {
        expect(LogChunker.chunk('small', 100)).toEqual(['small']);
    });

    it('always yields at least one piece, even for empty input', () => {
        expect(LogChunker.chunk('', 100)).toEqual(['']);
    });

    it('round-trips exactly — nothing is lost or duplicated', () => {
        const text = 'x'.repeat(1000);
        const chunks = LogChunker.chunk(text, 100);
        expect(chunks.length).toBe(10);
        expect(chunks.join('')).toBe(text);
    });

    it('keeps EVERY piece within budget, measured as JSON would escape it', () => {
        // Quote-dense, like a real serialized DTO — the case where raw-byte chunking overflows.
        const items: { id: number; name: string }[] = [];
        for (let i = 0; i < 500; i++) {
            items.push({ id: i, name: `n${i}` });
        }
        const body = JSON.stringify({ items });
        const chunks = LogChunker.chunk(body, 1024);

        expect(chunks.length).toBeGreaterThan(1);
        for (const piece of chunks) {
            expect(actualEscapedBytes(piece)).toBeLessThanOrEqual(1024);
        }
        expect(chunks.join('')).toBe(body);
    });

    it('never splits a multi-byte code point in half', () => {
        // 4-byte emoji against a budget that is not a multiple of 4 — boundaries must still land clean.
        const text = '😀'.repeat(100);
        const chunks = LogChunker.chunk(text, 10);

        for (const piece of chunks) {
            // A severed surrogate pair would decode to U+FFFD; every piece must be intact emoji.
            expect(piece).not.toContain('�');
            expect([...piece].every((char: string) => char === '😀')).toBe(true);
            expect(actualEscapedBytes(piece)).toBeLessThanOrEqual(10);
        }
        expect(chunks.join('')).toBe(text);
    });

    it('handles a realistic oversized body at the real budget', () => {
        const text = 'a'.repeat(GCP_LOG_BUDGET_BYTES * 2 + 50);
        const chunks = LogChunker.chunk(text, GCP_LOG_BUDGET_BYTES);

        expect(chunks.length).toBe(3);
        for (const piece of chunks) {
            expect(actualEscapedBytes(piece)).toBeLessThanOrEqual(GCP_LOG_BUDGET_BYTES);
        }
        expect(chunks.join('')).toBe(text);
    });

    it('rejects a nonsense budget rather than looping forever', () => {
        expect(() => LogChunker.chunk('abc', 0)).toThrow(/must be positive/);
    });
});

describe('LogChunker.newUid', () => {
    it('is unique per call — two split messages must never collide when grepped', () => {
        const ids = new Set<string>();
        for (let i = 0; i < 200; i++) {
            ids.add(LogChunker.newUid());
        }
        expect(ids.size).toBe(200);
    });
});
