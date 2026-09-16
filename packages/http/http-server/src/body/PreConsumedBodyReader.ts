import { Request } from 'express';
import { ApiBadRequestError, ApiImplementationError } from '@webpieces/core-util';
import { RequestBodyReader } from './RequestBodyReader';
import { StreamBodyReader } from './StreamBodyReader';

/**
 * OPT-IN {@link RequestBodyReader} for hosts that parse the body BEFORE webpieces runs: Cloud
 * Functions gen2 / Firebase (the Functions Framework), or an app that mounts
 * `express.json({ verify })` ahead of webpieces. Enable it with
 * `router.setBodyReader(new PreConsumedBodyReader())` before `bindExpress(app)`.
 *
 * Decision order:
 * 1. `req.rawBody` is a `Buffer`: use it. These are the exact bytes the sender transmitted, so a
 *    `{ rawBody: true }` webhook route still verifies its signature. The size cap is still enforced.
 * 2. the stream was NOT consumed: read it normally (same as {@link StreamBodyReader}).
 * 3. otherwise: fail fast naming the cure. The host must expose `req.rawBody`.
 *
 * Deliberately NO `JSON.stringify(req.body)` fallback. Re-serialized bytes differ from what was sent
 * (whitespace, key order, number formatting), which silently breaks webhook signature verification,
 * and the host this exists for (#937) always sets `req.rawBody`.
 *
 * Opt-in rather than the default so every correctly mounted server keeps the plain stream read.
 */
export class PreConsumedBodyReader implements RequestBodyReader {
    private readonly streamReader = new StreamBodyReader();

    read(req: Request, maxBodyBytes: number): Promise<Buffer> {
        // webpieces-disable no-any-unknown -- `rawBody` is set by the host, absent from the express types
        const rawBody = (req as unknown as Record<string, unknown>)['rawBody'];
        if (Buffer.isBuffer(rawBody)) {
            if (rawBody.length > maxBodyBytes) {
                return Promise.reject(
                    new ApiBadRequestError(`Request body exceeds the ${maxBodyBytes} byte limit`),
                );
            }
            return Promise.resolve(rawBody);
        }
        if (!this.streamReader.isConsumed(req)) {
            return this.streamReader.read(req, maxBodyBytes);
        }
        return Promise.reject(
            new ApiImplementationError(
                'PreConsumedBodyReader: the request body stream was already consumed and ' +
                    '`req.rawBody` is not a Buffer, so the verbatim body bytes are unavailable. ' +
                    'Fix: have the host keep the bytes on `req.rawBody`, e.g. ' +
                    '`express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })`, ' +
                    'or mount webpieces BEFORE the body parser.',
            ),
        );
    }
}
