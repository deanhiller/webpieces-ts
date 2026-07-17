import { Writable } from 'stream';
import { GCP_LOG_BUDGET_BYTES, LogChunker, LogChunkInfo } from '@webpieces/core-util';
import { LoggedError } from './LoggedError';

// JSON-shaped value (the widest thing a record field can hold), used instead of `any`/`unknown`
// which the code rules disallow. Mirrors the JsonValue in streams.ts, plus bigint — which
// JSON.stringify refuses outright, so serializedBytes below must be able to see and rewrite it.
type JsonValue = string | number | boolean | bigint | object | null | undefined;

/**
 * A bunyan record as it reaches a `type: 'raw'` stream: the standard fields (v, level, name, time,
 * msg, err, ...) plus whatever context tags the logger injected. Values are whatever JSON holds.
 */
type BunyanRecord = Record<string, JsonValue>;

/**
 * ChunkingRawStream - sits between bunyan and the Cloud Logging stream, SPLITTING an oversized
 * record into several complete records instead of letting it be rejected.
 *
 * WHY: Cloud Logging caps a LogEntry at 256 KiB, and on the API path an oversized entry fails the
 * whole `entries.write` call — `INVALID_ARGUMENT: Log entry with size X exceeds maximum size of
 * 256.0K` — which can take good entries batched alongside it down too. A 300KB stack trace or
 * response body is not exotic; it is exactly what you most want to read.
 *
 * WHY NOT TRUNCATE (what this replaces): the previous guard cut a big error down to 5 stack frames.
 * That kept the line under the limit by destroying its only useful content. Splitting keeps all of
 * it, addressable by `jsonPayload.logChunk.uid`.
 *
 * WHY A STREAM WRAPPER, not the BunyanLogger: bunyan's own machinery (and anything else writing to
 * the logger) reaches the stream directly, and the stream is where the size limit actually lives.
 * `loggingBunyan.stream()` is `type: 'raw'`, so we receive the record OBJECT — no parsing needed,
 * and rebuilding a piece is just a field swap.
 *
 * GCP-ONLY: wired in by {@link createGoogleCloudStream}. The local console stream is untouched — a
 * dev terminal has no size limit, and splitting there would only hurt readability.
 */
export class ChunkingRawStream extends Writable {
    private readonly target: Writable;
    private readonly budgetBytes: number;

    constructor(target: Writable, budgetBytes: number = GCP_LOG_BUDGET_BYTES) {
        // objectMode: bunyan hands a raw stream the record OBJECT, not a serialized line.
        super({ objectMode: true });
        this.target = target;
        this.budgetBytes = budgetBytes;
    }

    override _write(
        record: BunyanRecord,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
    ): void {
        for (const piece of this.split(record)) {
            this.target.write(piece);
        }
        callback();
    }

    /** The record as-is when it fits; otherwise one complete record per chunk. */
    private split(record: BunyanRecord): BunyanRecord[] {
        const renderedBytes = this.serializedBytes(record);
        if (renderedBytes <= this.budgetBytes) {
            // The overwhelmingly common path — through untouched, no tag added.
            return [record];
        }

        const message = typeof record['msg'] === 'string' ? record['msg'] : String(record['msg'] ?? '');
        const err = record['err'] as LoggedError | undefined;
        const stack = err?.stack;

        const budgets = LogChunker.chunkBudgets(renderedBytes, this.budgetBytes, message, stack ?? '');
        const messageChunks = LogChunker.chunk(message, budgets.firstBudget);
        const stackChunks = LogChunker.chunk(stack ?? '', budgets.secondBudget);

        const uid = LogChunker.newUid();
        const total = Math.max(messageChunks.length, stackChunks.length);
        const pieces: BunyanRecord[] = [];
        for (let index = 0; index < total; index++) {
            pieces.push(
                this.buildRecord(
                    record,
                    messageChunks[index] ?? '',
                    err === undefined ? undefined : new LoggedError(err.name, err.message, stackChunks[index] ?? ''),
                    new LogChunkInfo(uid, index, total),
                ),
            );
        }
        return pieces;
    }

    /** One piece: every original field, with `msg`/`err.stack` replaced and a `logChunk` tag added. */
    private buildRecord(
        record: BunyanRecord,
        messageChunk: string,
        err: LoggedError | undefined,
        chunkInfo: LogChunkInfo,
    ): BunyanRecord {
        const piece: BunyanRecord = Object.assign({}, record);
        piece['msg'] = messageChunk;
        piece['logChunk'] = chunkInfo;
        if (err !== undefined) {
            piece['err'] = err;
        }
        return piece;
    }

    /**
     * Serialized size of the record.
     *
     * Measured as JSON even though this path ships over gRPC/protobuf, where the true size differs.
     * JSON over-counts (every key is spelled out, every string escaped), and over-counting is the
     * safe direction: we chunk slightly sooner than strictly needed rather than one byte too late.
     *
     * The replacer is what makes this TOTAL, with no try/catch: a plain JSON.stringify throws on a
     * circular value — real here, since request/response object cycles are exactly why the winston
     * backend runs safe-stable-stringify — and on a bigint. A measurement that throws would take
     * down the very log line this class exists to save.
     */
    private serializedBytes(record: BunyanRecord): number {
        const seen = new WeakSet<object>();
        const json = JSON.stringify(record, (_key: string, value: JsonValue): JsonValue => {
            if (typeof value === 'bigint') {
                return value.toString();
            }
            if (typeof value === 'object' && value !== null) {
                if (seen.has(value)) {
                    return '[Circular]';
                }
                seen.add(value);
            }
            return value;
        });
        return LogChunker.byteLength(json);
    }
}
