import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import {
    HeaderRegistry,
    LogManager,
    Logger,
    LoggerFactory,
    OAuthBearerChallenge,
    OAuthErrorCode,
    OAuthErrorExtras,
    OAuthProtocolError,
} from '@webpieces/core-util';
import { OAuthExpressErrorHandler } from '../OAuthExpressErrorHandler';

class LogLine {
    constructor(
        public readonly level: string,
        public readonly message: string,
    ) {}
}

/** Records every line WITH its level, so the spec can assert a refusal is INFO, not ERROR. */
class LevelCapturingLoggerFactory implements LoggerFactory {
    readonly lines: LogLine[] = [];
    getLogger(_name: string): Logger {
        const at =
            (level: string) =>
            (message: string): void => {
                this.lines.push(new LogLine(level, message));
            };
        return {
            trace: at('trace'),
            debug: at('debug'),
            info: at('info'),
            warn: at('warn'),
            error: at('error'),
        };
    }
}

/** Captures what the handler writes. */
class FakeResponse {
    public statusCode?: number;
    public statusMessage?: string;
    public body?: string;
    public headersSent = false;
    public readonly headers: Array<[string, string]> = [];

    status(code: number): this {
        this.statusCode = code;
        return this;
    }
    setHeader(name: string, value: string): this {
        this.headers.push([name, value]);
        return this;
    }
    append(name: string, value: string): this {
        this.headers.push([name, value]);
        return this;
    }
    send(payload: string): this {
        this.body = payload;
        this.headersSent = true;
        return this;
    }
    header(name: string): string | undefined {
        return this.headers.find(
            (h: [string, string]) => h[0].toLowerCase() === name.toLowerCase(),
        )?.[1];
    }
}

const capturing = new LevelCapturingLoggerFactory();

beforeAll(() => {
    if (!HeaderRegistry.isConfigured()) {
        HeaderRegistry.configure([], /*platformHeaders*/ false);
    }
    LogManager.setFactory(capturing);
});

beforeEach(() => {
    capturing.lines.length = 0;
});

describe('OAuthExpressErrorHandler (#1176)', () => {
    it('renders invalid_grant as RFC 6749 §5.2 JSON at 400 and logs it at INFO, never ERROR', () => {
        const res = new FakeResponse();
        const forwarded: unknown[] = [];
        new OAuthExpressErrorHandler().middleware(
            new OAuthProtocolError(OAuthErrorCode.INVALID_GRANT, 'authorization code expired'),
            {} as Request,
            res as unknown as Response,
            ((err: unknown) => forwarded.push(err)) as NextFunction,
        );

        expect(forwarded).toEqual([]);
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body!)).toEqual({
            error: 'invalid_grant',
            error_description: 'authorization code expired',
        });
        expect(res.header('content-type')).toBe('application/json');
        expect(res.header('cache-control')).toBe('no-store');
        expect(capturing.lines.map((l: LogLine) => l.level)).toEqual(['info']);
        expect(capturing.lines[0].message).toContain('error=invalid_grant');
    });

    it('sends the WWW-Authenticate challenge and 401 for invalid_token', () => {
        const res = new FakeResponse();
        const challenge = new OAuthBearerChallenge(
            OAuthErrorCode.INVALID_TOKEN,
            'expired',
            undefined,
            'mcp',
        ).toHeaderValue();
        new OAuthExpressErrorHandler().write(
            res as unknown as Response,
            new OAuthProtocolError(
                OAuthErrorCode.INVALID_TOKEN,
                'expired',
                new OAuthErrorExtras(undefined, challenge),
            ),
        );
        expect(res.statusCode).toBe(401);
        expect(res.header('www-authenticate')).toBe(
            'Bearer realm="mcp", error="invalid_token", error_description="expired"',
        );
    });

    it('passes anything that is not an OAuthProtocolError to the next error handler untouched', () => {
        const res = new FakeResponse();
        const bug = new Error('a real bug');
        const forwarded: unknown[] = [];
        new OAuthExpressErrorHandler().middleware(
            bug,
            {} as Request,
            res as unknown as Response,
            ((err: unknown) => forwarded.push(err)) as NextFunction,
        );
        expect(forwarded).toEqual([bug]);
        expect(res.statusCode).toBeUndefined();
        expect(capturing.lines).toEqual([]);
    });
});
