import { Request } from 'express';
import { ApiBadRequestError, ApiImplementationError } from '@webpieces/core-util';
import { RequestBodyReader } from './RequestBodyReader';

/**
 * The DEFAULT {@link RequestBodyReader}: read the body off the express request stream.
 *
 * This is the logic `ExpressWrapper.readRequestBody` always had, unchanged, plus ONE guard. A stream
 * that something upstream already consumed (a body parser mounted ahead of webpieces, or a host like
 * Cloud Functions gen2 that parses before the app runs) never emits `end` again, so waiting on it
 * hung the request until the platform timeout with nothing in the logs (issue #937). That case now
 * throws immediately, and the message names both cures.
 */
export class StreamBodyReader implements RequestBodyReader {
    read(req: Request, maxBodyBytes: number): Promise<Buffer> {
        if (this.isConsumed(req)) {
            return Promise.reject(
                new ApiImplementationError(
                    'The request body stream was already consumed before webpieces could read it ' +
                        '(a body parser or the hosting platform read it first), and reading it again ' +
                        'would hang forever. Fix: call ' +
                        '`router.setBodyReader(new PreConsumedBodyReader())` before ' +
                        '`bindExpress(app)` when the host keeps the verbatim bytes on `req.rawBody` ' +
                        '(Cloud Functions gen2 / Firebase), or mount webpieces BEFORE the body parser.',
                ),
            );
        }
        return this.readStream(req, maxBodyBytes);
    }

    /**
     * True when the request stream can no longer produce a body.
     *
     * `readableEnded` is set once `end` has been emitted, which every complete read (the Functions
     * Framework, body-parser 2's raw-body) leaves behind. body-parser 1.x also marks the request with
     * `_body = true` after parsing it. That marker is checked together with `complete` so a stray
     * `_body` field on a request nobody has read yet is not mistaken for a consumed stream.
     */
    isConsumed(req: Request): boolean {
        if (req.readableEnded) {
            return true;
        }
        // webpieces-disable no-any-unknown -- `_body` is body-parser 1.x's private marker, absent from the express types
        const marker = (req as unknown as Record<string, unknown>)['_body'];
        return req.complete === true && marker === true;
    }

    /**
     * Read the raw request body as BYTES (we parse manually rather than mounting express.json()).
     *
     * Bytes, not a growing string: a per-chunk `toString()` splits any multi-byte character that
     * straddles a chunk boundary into two replacement characters, so the body a webhook hook verified
     * would not be the body the vendor signed.
     *
     * REFUSES a body over `maxBodyBytes` the moment it crosses the line. The chunks read so far are
     * dropped and the stream is destroyed, so an oversize body is never fully buffered. It answers
     * 400 rather than 401 even on a webhook route, unavoidably: there is no way to authenticate a
     * caller whose request we are refusing to finish reading, and that ordering is the point.
     */
    private readStream(req: Request, maxBodyBytes: number): Promise<Buffer> {
        return new Promise((resolve: (body: Buffer) => void, reject: (err: Error) => void) => {
            let chunks: Buffer[] = [];
            let size = 0;
            // A socket emits Buffers; a stream someone put in string mode (or a test's Readable.from)
            // emits strings. Normalize to bytes ONCE, here, so everything downstream counts and
            // concatenates the same units.
            req.on('data', (data: Buffer | string) => {
                const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
                size += chunk.length;
                if (size > maxBodyBytes) {
                    chunks = [];
                    req.destroy();
                    reject(
                        new ApiBadRequestError(`Request body exceeds the ${maxBodyBytes} byte limit`),
                    );
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', () => {
                resolve(Buffer.concat(chunks));
            });
            req.on('error', (err: Error) => {
                reject(err);
            });
        });
    }
}
