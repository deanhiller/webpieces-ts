/**
 * LogChunker - splits an oversized log field into pieces small enough that each emitted record
 * survives GCP Cloud Logging's per-entry size limit.
 *
 * WHY THIS EXISTS: an oversized entry does NOT come back as an error — it is SILENTLY DROPPED.
 * Per the GKE docs: "Any LogEntry exceeding the size limit is dropped for jsonPayload logs and
 * truncated for textPayload logs." Our GCP backends emit structured JSON, so we are squarely in the
 * "dropped" half: a 300KB response body or a giant stack trace makes the whole line vanish with no
 * diagnostic anywhere. Chunking is what turns that silent loss into N recoverable lines.
 *
 * WHY NOT TRUNCATE: the content that blows the limit (a stack trace, a response body) is precisely
 * the content you opened the logs to read. Splitting keeps all of it.
 *
 * WHY NOT SPLIT THE SERIALIZED LINE: a fragment of a JSON line is not valid JSON, and the logging
 * agent would file each piece as an unparsed `textPayload` — losing every structured field. So
 * callers chunk a FIELD and emit N COMPLETE records, each carrying a `logChunk` tag.
 *
 * WHY GCP's OWN SPLITTING DOES NOT HELP: Cloud Logging's `LogSplit` (split.uid/index/totalSplits) is
 * only applied to Google-generated audit logs, never to user-written entries. We mirror its field
 * shape ({@link LogChunkInfo}) but must do the work ourselves.
 *
 * BROWSER-SAFE: lives in core-util, which ships in the browser bundle — so `TextEncoder`, never
 * `Buffer`.
 *
 * Singleton, mirroring `LogApiCall` / `RequestContext`: use the exported {@link LogChunker}, not `new`.
 */

/**
 * GCP Cloud Logging's maximum size for a single LogEntry: 256 KiB. Note KiB, not KB — the docs say
 * 256 KiB, so 262,144 bytes and NOT the 256,000 that several client libraries hardcode as their own
 * conservative guard.
 */
export const MAX_GCP_LOG_BYTES = 262_144;

/**
 * The per-record budget we actually chunk to: 75% of {@link MAX_GCP_LOG_BYTES}.
 *
 * The 25% headroom is NOT superstition — three things eat into the limit that a caller cannot see:
 * 1. The limit is explicitly "approximate and based on internal data sizes, not the actual REST API
 *    request size" (GCP quotas docs), so byte-exact packing against 262,144 is not a thing you can do.
 * 2. Labels, resource, and metadata share the entry's budget with the payload.
 * 3. The record envelope — context keys (requestId, tenantId, ...), the `api` tag, svcName, severity,
 *    timestamps — is serialized alongside the field being chunked.
 */
export const GCP_LOG_BUDGET_BYTES = 196_608;

/**
 * The tag stamped on every record of a split message, mirroring GCP's own `LogSplit` shape.
 * Data-only structure → a class, per CLAUDE.md.
 *
 * Reassembling in Cloud Logging: filter `jsonPayload.logChunk.uid="<uid>"`, sort by
 * `jsonPayload.logChunk.index`, concatenate the `message` fields.
 *
 * WHY A DEDICATED uid, given every line already carries requestId: requestId correlates a whole
 * REQUEST, which emits many lines (LogApiCall alone emits a request line AND a response line per
 * call). It cannot tell you which lines are pieces of ONE message. This uid can.
 */
export class LogChunkInfo {
    constructor(
        /** Correlates the pieces of ONE split message. */
        readonly uid: string,
        /** 0-based position of this piece. */
        readonly index: number,
        /** How many pieces this message was split into. */
        readonly total: number,
    ) {}
}

/**
 * Bytes reserved for the `logChunk` tag a backend adds to each piece, e.g.
 * `,"logChunk":{"uid":"chunk-mabc1234-x7f2q1","index":12,"total":34}` — ~70 bytes, rounded up.
 */
const CHUNK_TAG_BYTES = 128;

/**
 * Floor for a per-record field budget. Only reachable if the ENVELOPE alone (context keys, the api
 * tag, svcName) already fills the budget — pathological, and slicing a message into 1-byte pieces
 * would be worse than emitting one slightly-oversized record.
 */
const MIN_FIELD_BYTES = 1024;

/**
 * How many bytes each of two chunked fields may spend PER RECORD. Data-only structure → a class.
 */
export class ChunkBudgets {
    constructor(
        readonly firstBudget: number,
        readonly secondBudget: number,
    ) {}
}

export class LogChunkerImpl {
    private readonly encoder = new TextEncoder();

    /**
     * Plain UTF-8 byte length — for measuring text that is ALREADY in its final serialized form
     * (e.g. winston's fully-rendered JSON line), where no further escaping will happen.
     */
    byteLength(text: string): number {
        return this.encoder.encode(text).length;
    }

    /**
     * The byte cost of `text` once it has been JSON-escaped as a string VALUE inside a record.
     *
     * This is the measurement that matters, and it is why chunking on raw UTF-8 length is a bug: a
     * log message holding a JSON body is escaped a SECOND time when the record is serialized, so
     * every `"` becomes `\"`, every newline `\n`, and a control character explodes to a 6-byte
     * `\u00XX`. A body that is dense in quotes can inflate by ~2x on that second pass — enough to
     * push a "196KB" chunk past the 262KB ceiling and silently drop it.
     *
     * Exact for `JSON.stringify` semantics (V8 does not \u-escape non-ASCII). For the bunyan GCP
     * path — which ships over gRPC/protobuf rather than as JSON text — this over-counts slightly,
     * which is the safe direction.
     */
    escapedByteLength(text: string): number {
        let bytes = 0;
        // for...of iterates CODE POINTS, so a surrogate pair is one step, not two.
        for (const char of text) {
            bytes += this.escapedCost(char.codePointAt(0)!);
        }
        return bytes;
    }

    /**
     * Split `text` so each piece costs at most `maxBytes` once JSON-escaped
     * (see {@link escapedByteLength}).
     *
     * GUARANTEES:
     * - `chunk(t, n).join('') === t` — nothing is lost, so the pieces reassemble exactly.
     * - No piece splits a code point: a 4-byte emoji or a CJK character is never cut in half (which
     *   would corrupt the boundary character into replacement junk on reassembly).
     * - Always returns at least one piece (`['']` for empty input), so callers can treat the result
     *   uniformly.
     *
     * Degenerate case: if a SINGLE code point costs more than `maxBytes`, that piece necessarily
     * exceeds the budget — unavoidable, and irrelevant at any sane budget (max cost is 6 bytes).
     */
    chunk(text: string, maxBytes: number): string[] {
        if (maxBytes <= 0) {
            throw new Error(`maxBytes must be positive, was ${maxBytes}`);
        }
        if (this.escapedByteLength(text) <= maxBytes) {
            return [text];
        }

        const chunks: string[] = [];
        let start = 0;
        // UTF-16 index (what slice() wants), advanced by each code point's unit length so every
        // boundary we cut on is a code-point boundary.
        let position = 0;
        let bytes = 0;
        for (const char of text) {
            const cost = this.escapedCost(char.codePointAt(0)!);
            if (bytes + cost > maxBytes && position > start) {
                chunks.push(text.slice(start, position));
                start = position;
                bytes = 0;
            }
            bytes += cost;
            position += char.length;
        }
        chunks.push(text.slice(start));
        return chunks;
    }

    /**
     * Divide a record's budget between the TWO fields a backend chunks — the message and the stack
     * trace. Shared by the winston and bunyan GCP backends, which differ only in what those fields
     * are called (`message`/`errStack` vs `msg`/`err.stack`), never in this arithmetic.
     *
     * The envelope's cost is derived by SUBTRACTION: `renderedBytes` minus the escaped cost of the
     * two fields IS the envelope, whatever it happens to hold. That stays correct as apps register
     * new context keys, where summing up known parts would silently drift.
     *
     * The split: whichever field is small enough to fit whole gets exactly what it needs and the
     * other takes the rest; if BOTH are oversized they share evenly. Either way record N holds
     * first[N] + second[N] and still lands within budget.
     *
     * @param renderedBytes - size of the fully-serialized record as it stands today
     * @param budgetBytes   - the per-record ceiling (typically {@link GCP_LOG_BUDGET_BYTES})
     */
    chunkBudgets(renderedBytes: number, budgetBytes: number, first: string, second: string): ChunkBudgets {
        const firstBytes = this.escapedByteLength(first);
        const secondBytes = this.escapedByteLength(second);
        const envelopeBytes = renderedBytes - firstBytes - secondBytes;
        const available = Math.max(budgetBytes - envelopeBytes - CHUNK_TAG_BYTES, MIN_FIELD_BYTES);
        const half = Math.floor(available / 2);

        // Both too big to fit alongside anything → split the room evenly.
        if (firstBytes > half && secondBytes > half) {
            return new ChunkBudgets(half, half);
        }
        // A field that fits in one piece is given exactly its own size (never 0 — chunk() rejects
        // that), and the oversized field gets everything left over.
        if (secondBytes <= half) {
            return new ChunkBudgets(Math.max(available - secondBytes, MIN_FIELD_BYTES), Math.max(secondBytes, 1));
        }
        return new ChunkBudgets(Math.max(firstBytes, 1), Math.max(available - firstBytes, MIN_FIELD_BYTES));
    }

    /**
     * A fresh id correlating the pieces of one split message. Uses Math.random rather than
     * crypto.randomUUID so it works in every browser context (randomUUID needs a secure context) and
     * on older Node — matching how RequestContextHeaders generates its fallback request id. These
     * only need to be unique among the lines an operator is grepping, not cryptographically strong.
     */
    newUid(): string {
        return `chunk-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 10)}`;
    }

    /** Bytes this code point occupies once JSON-escaped inside a string value. */
    private escapedCost(codePoint: number): number {
        // The characters JSON.stringify escapes with a 2-char backslash sequence: " \ \b \t \n \f \r
        if (codePoint === 0x22 || codePoint === 0x5c) {
            return 2;
        }
        if (
            codePoint === 0x08 ||
            codePoint === 0x09 ||
            codePoint === 0x0a ||
            codePoint === 0x0c ||
            codePoint === 0x0d
        ) {
            return 2;
        }
        // Every other control character becomes a 6-byte \u00XX escape.
        if (codePoint < 0x20) {
            return 6;
        }
        // Otherwise the character is emitted as-is, costing its UTF-8 length.
        if (codePoint < 0x80) {
            return 1;
        }
        if (codePoint < 0x800) {
            return 2;
        }
        if (codePoint < 0x10000) {
            return 3;
        }
        return 4;
    }
}

/**
 * The process-wide {@link LogChunkerImpl} singleton — mirrors the `LogApiCall` export pattern.
 * Callers use `LogChunker.chunk(...)`, never `new`.
 */
export const LogChunker = new LogChunkerImpl();
