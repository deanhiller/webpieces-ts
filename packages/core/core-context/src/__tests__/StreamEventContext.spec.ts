import { describe, expect, it } from 'vitest';
import { HeaderRegistry, WebpiecesCoreHeaders } from '@webpieces/core-util';
import { HttpRequest } from '../HttpRequest';
import { RequestContext } from '../RequestContext';
import { StreamEventContext } from '../StreamEventContext';

describe('stream event scopes', () => {
    it('gives unsolicited output a local ID while retaining a triggering inbound event ID', async () => {
        HeaderRegistry.configure([], true);
        await RequestContext.run(async (): Promise<void> => {
            RequestContext.putUntrusted(WebpiecesCoreHeaders.REQUEST_ID, 'opening-8');
            const events = new StreamEventContext();
            const first = events.runOutbound((): string | undefined =>
                RequestContext.getUntrusted(WebpiecesCoreHeaders.STREAM_EVENT_ID),
            );
            const second = events.runOutbound((): string | undefined =>
                RequestContext.getUntrusted(WebpiecesCoreHeaders.STREAM_EVENT_ID),
            );
            expect(first).toBeTruthy();
            expect(second).not.toBe(first);
            await events.run(async (): Promise<void> => {
                const inbound = RequestContext.getUntrusted(WebpiecesCoreHeaders.STREAM_EVENT_ID);
                await Promise.resolve();
                expect(
                    events.runOutbound((): string | undefined =>
                        RequestContext.getUntrusted(WebpiecesCoreHeaders.STREAM_EVENT_ID),
                    ),
                ).toBe(inbound);
            });
        });
    });
    it('isolates overlapping continuations, log IDs, and mutable opening headers', async () => {
        HeaderRegistry.configure([], true);
        await RequestContext.run(async (): Promise<void> => {
            RequestContext.putUntrusted(WebpiecesCoreHeaders.REQUEST_ID, 'opening-7');
            RequestContext.setRequest(
                new HttpRequest('POST', '/stream', new Map([['x-room', ['original']]])),
            );
            const events = new StreamEventContext();
            let release!: () => void;
            const overlap = new Promise<void>((resolve: () => void): void => {
                release = resolve;
            });
            let firstId: string | undefined;
            let secondId: string | undefined;
            const first = events.run(async (): Promise<void> => {
                firstId = RequestContext.getUntrusted(WebpiecesCoreHeaders.STREAM_EVENT_ID);
                RequestContext.getRequest()!.headers.set('x-room', ['mutated']);
                RequestContext.putUntrusted(WebpiecesCoreHeaders.REQUEST_ID, 'mutated');
                await overlap;
                expect(RequestContext.buildStructuredLogFields().get('streamEventId')).toBe(
                    firstId,
                );
            });
            await events.run(async (): Promise<void> => {
                secondId = RequestContext.getUntrusted(WebpiecesCoreHeaders.STREAM_EVENT_ID);
                expect(RequestContext.getUntrusted(WebpiecesCoreHeaders.REQUEST_ID)).toBe(
                    'opening-7',
                );
                expect(RequestContext.getRequest()?.getHeader('x-room')).toBe('original');
                await Promise.resolve();
                expect(RequestContext.buildStructuredLogFields().get('streamEventId')).toBe(
                    secondId,
                );
                release();
            });
            await first;
            expect(firstId).toBeTruthy();
            expect(secondId).toBeTruthy();
            expect(firstId).not.toBe(secondId);
            expect(
                RequestContext.getUntrusted(WebpiecesCoreHeaders.STREAM_EVENT_ID),
            ).toBeUndefined();
            expect(RequestContext.getRequest()?.getHeader('x-room')).toBe('original');
            expect(WebpiecesCoreHeaders.STREAM_EVENT_ID.httpHeader).toBeUndefined();
            expect(WebpiecesCoreHeaders.STREAM_EVENT_ID.responseHeader).toBeUndefined();
        });
    });
});
