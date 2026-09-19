import { Response } from 'express';
import { HttpHeader, HttpResponseDto } from '@webpieces/core-util';

/**
 * The ONE place an {@link HttpResponseDto} becomes bytes on an express response.
 *
 * Every webpieces surface that owns a socket writes through this: `ExpressWrapper.handleError` for
 * the ordinary API path (webpieces' own default AND an app's `ErrorTranslators`), and
 * `WpMcpServer`'s pre-SDK boundary, which used to hand-roll `res.status(...).json(...)` and so got
 * none of the rules below. Producing a VALUE and handing it here is what makes those two paths the
 * same path.
 *
 * `append`, not `setHeader`, because the DTO's headers are a LIST: HTTP permits repeats
 * (`Set-Cookie` is the everyday one) and `setHeader` would keep only the last of them. That list
 * shape is the whole reason the DTO does not use a Map.
 *
 * `Content-Type: application/json` is INFRASTRUCTURE here, not app policy: webpieces is the one
 * doing the `JSON.stringify`, so it states what it wrote. Express would otherwise default a string
 * body to `text/html`, which is wrong for every response this framework sends. A translator that
 * genuinely wants another type says so in its own header list and wins.
 */
export class ExpressResponseWriter {
    write(res: Response, response: HttpResponseDto): void {
        const declaresContentType = response.headers.some(
            (header: HttpHeader) => header.name.toLowerCase() === 'content-type',
        );
        if (!declaresContentType && response.body !== undefined) {
            res.setHeader('Content-Type', 'application/json');
        }
        for (const header of response.headers) {
            res.append(header.name, header.value);
        }
        // express writes the reason phrase from `statusMessage`, so a translator that says
        // `new HttpResponseStatus(460, 'Order Not Found')` gets 'Order Not Found' on the status line
        // rather than node's blank default for an unregistered code.
        res.statusMessage = response.status.reason;
        const payload =
            response.body === undefined
                ? undefined
                : this.responsePayload(response, declaresContentType);
        res.status(response.status.code).send(payload);
    }

    /** JSON by default; explicit text content types write the caller's string verbatim. */
    private responsePayload(response: HttpResponseDto, declaresContentType: boolean): string {
        const contentType = response.headers.find(
            (header: HttpHeader) => header.name.toLowerCase() === 'content-type',
        )?.value;
        if (declaresContentType && contentType !== undefined && !/json/i.test(contentType)) {
            return typeof response.body === 'string' ? response.body : String(response.body);
        }
        return JSON.stringify(response.body) ?? '';
    }
}
