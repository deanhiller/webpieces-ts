import { Request } from 'express';

/**
 * How a webpieces route obtains the inbound body BYTES from express.
 *
 * webpieces parses bodies itself (it never mounts `express.json()`), so by default it reads the
 * request stream. That only works when nothing upstream read the stream first. Some hosts do:
 * Cloud Functions gen2 / Firebase run a body parser BEFORE the app sees the request and leave the
 * verbatim bytes on `req.rawBody`. Reading the drained stream there waits for an `end` event that
 * already fired, so the request hangs until the platform timeout (issue #937).
 *
 * The reader is chosen ONCE per router via `WebpiecesExpressRouter.setBodyReader(...)`:
 * - {@link StreamBodyReader}: the default. Reads the stream, fails fast if it was already consumed.
 * - {@link PreConsumedBodyReader}: opt-in for hosts that parse first. Uses `req.rawBody`.
 *
 * An interface (not a class) because it is behaviour: an implementation decides WHERE the bytes come
 * from. Whatever it returns must be the bytes the sender transmitted, because a `{ rawBody: true }`
 * webhook route verifies a vendor signature over exactly this buffer.
 */
export interface RequestBodyReader {
    /**
     * @param req - the express request of a POST/PUT/PATCH route.
     * @param maxBodyBytes - the inbound cap. An implementation MUST refuse a larger body with an
     *   `ApiBadRequestError` rather than buffer it.
     * @returns the verbatim body bytes (empty for an empty body).
     */
    read(req: Request, maxBodyBytes: number): Promise<Buffer>;
}
