import { transports } from 'winston';
import type { TransformableInfo } from 'logform';
import { stringify as safeStringify } from 'safe-stable-stringify';
import { GCP_LOG_BUDGET_BYTES, LogChunker, LogChunkInfo } from '@webpieces/core-util';

// winston's own symbol (not a DI token): it holds the FINAL rendered line — what format.json()
// produced and what a transport actually writes — as distinct from the `message` string PROPERTY,
// which is the caller's text. We need both: the symbol to measure, the property to re-chunk.
// webpieces-disable no-symbol-di-tokens -- winston's documented internal record key (Symbol.for('message')), not a DI token
const MESSAGE = Symbol.for('message');

// JSON-shaped value (the widest thing a winston record field can hold), used instead of
// `any`/`unknown` which the code rules disallow. Mirrors the JsonValue in format.ts.
type JsonValue = string | number | boolean | bigint | object | null | undefined;

/**
 * ChunkingConsoleTransport - a winston Console transport that SPLITS an oversized record into
 * several complete records instead of letting GCP silently drop it.
 *
 * WHY A TRANSPORT, not the WinstonLogger wrapper — two reasons, both decisive:
 *
 * 1. COVERAGE. WinstonFactoryBase sets `handleExceptions: true` / `handleRejections: true`, and
 *    those lines are emitted by winston itself, bypassing WinstonLogger entirely. An uncaught
 *    exception carrying a huge stack trace is exactly the log you cannot afford to lose, so the
 *    guard has to sit below the wrapper.
 * 2. EXACT MEASUREMENT. A transport runs AFTER the format chain, so `info[MESSAGE]` is the fully
 *    rendered line — envelope and all (severity, svcName, requestId, tenantId, the `api` tag). We
 *    measure the real thing rather than estimating the caller's contribution and hoping.
 *
 * WHY IT RE-SERIALIZES rather than slicing `info[MESSAGE]`: a fragment of a JSON line is not valid
 * JSON, so the logging agent would file each piece as an unparsed `textPayload` and every structured
 * field would be lost. Each emitted piece must be a COMPLETE, parseable record — so we chunk the
 * oversized FIELDS and rebuild N records, each tagged with a shared {@link LogChunkInfo}.
 *
 * GCP-ONLY: wired in by WinstonGcpFactory. WinstonConsoleFactory keeps a plain Console transport —
 * a dev terminal has no size limit and splitting there would only hurt readability.
 *
 * The common case is untouched: a record within budget goes straight to `super.log` and is
 * byte-identical to what it was before this class existed.
 */
export class ChunkingConsoleTransport extends transports.Console {
    private readonly budgetBytes: number;

    constructor(budgetBytes: number = GCP_LOG_BUDGET_BYTES) {
        super();
        this.budgetBytes = budgetBytes;
    }

    override log(info: TransformableInfo, callback: () => void): void {
        const rendered = this.rendered(info);
        if (LogChunker.byteLength(rendered) <= this.budgetBytes) {
            // The overwhelmingly common path — unchanged behaviour, no extra work beyond one measure.
            this.writeThrough(info, callback);
            return;
        }
        this.logChunked(info, rendered, callback);
    }

    /**
     * Hand one finished record to the real Console transport. winston types `log` as optional on the
     * base, so we resolve it once here rather than sprinkling `?.` at the call sites — and if it were
     * ever truly absent we still fire the callback, because swallowing it would hang the logger.
     */
    private writeThrough(info: TransformableInfo, callback: () => void): void {
        const parentLog = super.log;
        if (!parentLog) {
            callback();
            return;
        }
        parentLog.call(this, info, callback);
    }

    /** Split the oversized record's fields and emit one complete record per piece. */
    private logChunked(info: TransformableInfo, rendered: string, callback: () => void): void {
        const message = typeof info.message === 'string' ? info.message : String(info.message ?? '');
        const stack = typeof info['errStack'] === 'string' ? info['errStack'] : undefined;

        const budgets = LogChunker.chunkBudgets(
            LogChunker.byteLength(rendered), this.budgetBytes, message, stack ?? '',
        );
        const messageChunks = LogChunker.chunk(message, budgets.firstBudget);
        const stackChunks = LogChunker.chunk(stack ?? '', budgets.secondBudget);

        const uid = LogChunker.newUid();
        const total = Math.max(messageChunks.length, stackChunks.length);
        for (let index = 0; index < total; index++) {
            const piece = this.buildRecord(
                info,
                messageChunks[index] ?? '',
                stack === undefined ? undefined : (stackChunks[index] ?? ''),
                new LogChunkInfo(uid, index, total),
            );
            // Only the LAST piece completes the write; winston expects exactly one callback per log().
            this.writeThrough(piece, index === total - 1 ? callback : (): void => undefined);
        }
    }

    /**
     * Rebuild one complete record: every original field, with `message`/`errStack` replaced by this
     * piece and a `logChunk` tag added, re-serialized exactly the way format.json() would (same
     * safe-stable-stringify, so circular refs stay "[Circular]").
     */
    private buildRecord(
        info: TransformableInfo,
        messageChunk: string,
        stackChunk: string | undefined,
        chunkInfo: LogChunkInfo,
    ): TransformableInfo {
        const fields: Record<string, JsonValue> = {};
        // Object.keys skips winston's symbol keys, so this is exactly the set format.json() serializes.
        for (const key of Object.keys(info)) {
            fields[key] = (info as Record<string, JsonValue>)[key];
        }
        fields['message'] = messageChunk;
        if (stackChunk !== undefined) {
            fields['errStack'] = stackChunk;
        }
        fields['logChunk'] = chunkInfo;

        // Object.assign copies own enumerable SYMBOL keys too, so winston's LEVEL symbol (which the
        // Console transport reads) survives; then we overwrite the rendered line with this piece's.
        const piece = Object.assign({}, info, fields) as TransformableInfo;
        (piece as Record<symbol, JsonValue>)[MESSAGE] = safeStringify(fields) ?? '';
        return piece;
    }

    /** The fully-rendered line the format chain produced (what a transport writes). */
    private rendered(info: TransformableInfo): string {
        const message = (info as Record<symbol, JsonValue>)[MESSAGE];
        return typeof message === 'string' ? message : String(message ?? '');
    }
}
