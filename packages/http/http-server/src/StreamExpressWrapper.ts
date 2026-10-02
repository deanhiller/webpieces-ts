import { NextFunction, Request, Response } from 'express';
import {
    ApiBadRequestError,
    DtoValue,
    RouteMetadata,
    StreamDirection,
    StreamEventValidator,
    StreamTransportError,
    toError,
} from '@webpieces/core-util';
import { HttpRequest, RequestContext, RequestContextHeaders } from '@webpieces/core-context';
import { ExpressWrapper } from './ExpressWrapper';
import { JsonlDuplexExpressCall, JsonlResponseWriter } from './JsonlDuplexExpressCall';

/** Express adapter for the three typed application/x-webpieces-jsonl contract forms. */
export class StreamExpressWrapper {
    private readonly ordinaryErrors: ExpressWrapper;
    private readonly validator = new StreamEventValidator();

    constructor(
        // webpieces-disable no-any-unknown -- stream contract types are erased at the express boundary
        private readonly clientMethod: (...args: unknown[]) => Promise<unknown>,
        private readonly route: RouteMetadata,
        private readonly headers: RequestContextHeaders,
    ) {
        this.ordinaryErrors = new ExpressWrapper(
            clientMethod,
            route.path,
            headers,
            false,
            false,
            undefined,
            route,
        );
    }

    async execute(req: Request, res: Response, _next: NextFunction): Promise<void> {
        await RequestContext.run(async () => this.executeInContext(req, res));
    }

    private async executeInContext(req: Request, res: Response): Promise<void> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- owning HTTP boundary maps pre-open failures with ordinary HTTP errors
        try {
            const request = this.toWebpiecesRequest(req);
            RequestContext.setRequest(request);
            this.headers.fillFromRequest(request);
            this.requireContentType(req);
            if (this.route.streaming?.direction === StreamDirection.RESPONSE) {
                await this.executeResponseStream(req, res);
                return;
            }
            await new JsonlDuplexExpressCall(this.clientMethod, this.route, this.headers).execute(
                req,
                res,
            );
        } catch (err: unknown) {
            const error = toError(err);
            if (res.headersSent) res.destroy(error);
            else this.ordinaryErrors.handleError(res, error);
        }
    }

    private async executeResponseStream(req: Request, res: Response): Promise<void> {
        const initial = await this.readInitial(req);
        if (this.route.streaming?.initialRequestSchema) {
            this.validator.validate(this.route.streaming.initialRequestSchema, initial, 'request');
        }
        const outbound = new JsonlResponseWriter(res, this.route, this.validator);
        const response = (await this.clientMethod(initial, outbound.stream)) as DtoValue;
        await outbound.open(response, this.headers.buildResponseHeaders());
    }

    private async readInitial(req: Request): Promise<DtoValue> {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const raw of req) {
            const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            bytes += chunk.length;
            if (bytes > 1024 * 1024) {
                throw new StreamTransportError('Initial JSONL record exceeds 1048576 bytes.');
            }
            chunks.push(chunk);
        }
        const lines = Buffer.concat(chunks)
            .toString('utf8')
            .split(/\r?\n/)
            .filter((line: string): boolean => line !== '');
        if (lines.length !== 1) {
            throw new StreamTransportError(
                'RESPONSE streaming requires exactly one initial request record.',
            );
        }
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- JSON.parse is the untrusted request boundary
        try {
            return JSON.parse(lines[0]) as DtoValue;
        } catch (err: unknown) {
            const error = toError(err);
            throw new StreamTransportError(
                'Malformed initial JSONL request.',
                undefined,
                undefined,
                error,
            );
        }
    }

    private requireContentType(req: Request): void {
        const contentType = req.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
        if (contentType !== 'application/x-webpieces-jsonl') {
            throw new ApiBadRequestError(
                'Streaming endpoints require Content-Type application/x-webpieces-jsonl.',
            );
        }
    }

    private toWebpiecesRequest(req: Request): HttpRequest {
        const headers = new Map<string, string[]>();
        for (const entry of Object.entries(req.headers)) {
            const value = entry[1];
            if (typeof value === 'string') headers.set(entry[0].toLowerCase(), [value]);
            else if (Array.isArray(value)) headers.set(entry[0].toLowerCase(), [...value]);
        }
        return new HttpRequest(req.method, req.path ?? this.route.path, headers);
    }
}
