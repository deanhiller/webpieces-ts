import { AnyContextKey, ContextKey, HeaderRegistry } from '@webpieces/core-util';
import { RequestContext } from '../RequestContext';

/**
 * The RUNTIME half of {@link RequestContext.runDetachedScope}. The compile-time half — that no
 * container of entries may be handed in, and that a key of unknown trust cannot be written at all —
 * is pinned by `DetachedScopeCompileAssertions`, which a spec cannot express (vitest strips types).
 *
 * The scenario is the real one this exists for: a browser-log shipper. A batch of lines arrives on ONE
 * server request; each line carries the context the BROWSER captured when the line was written, and a
 * batch routinely spans several user actions. Emitting a line under the shipping request's own scope
 * would stamp every line with that request's actionId — the feature would keep working while the
 * ability to grep an action was quietly destroyed.
 */
const USER_ID = ContextKey.trusted<string>('userId', 'jwt claim `sub`, stamped by AuthFilter', 'x-user-id');
const ACTION_ID = ContextKey.untrusted<string>('actionId', 'x-webpieces-actionid');
const REQUEST_ID = ContextKey.untrusted<string>('requestId', 'x-request-id');

function configure(): void {
    HeaderRegistry.configure([USER_ID, ACTION_ID, REQUEST_ID], /*platformHeaders*/ false);
}

/**
 * The shape of `BrowserLogController.emit()`: one line, emitted inside a scope rebuilt from what the
 * BROWSER sent, with nothing inherited from the shipping request.
 *
 * The loop is over the registry's mixed `AnyContextKey[]`, so it MUST branch on trust — `putUntrusted`
 * does not compile for a trusted key, and an `AnyContextKey` does not compile at all until its trust
 * has been tested.
 *
 * That is about the SOURCE, not about the key. A trusted key is perfectly writable — `putTrusted` is
 * how `AuthFilter` stamps a verified JWT claim, and how an app writes a value IT proved out of band. A
 * BROWSER proves nothing, so THIS code has no grounds to claim proof, and the compiler is what holds it
 * to that. See `putTrusted works inside a detached scope` below for the legitimate direction.
 */
class BrowserLogEmitter {
    emit(payload: Record<string, unknown>, loggedKeys: AnyContextKey[]): Map<string, string> {
        return RequestContext.runDetachedScope(() => {
            for (const key of loggedKeys) {
                if (key.isTrusted()) {
                    continue;
                }
                const value = payload[key.name];
                if (typeof value === 'string' && value !== '') {
                    RequestContext.putUntrusted(key, value);
                }
            }
            // What the winston/bunyan backends would stamp onto the line.
            return RequestContext.buildLogFields();
        });
    }
}

describe('RequestContext.runDetachedScope', () => {
    beforeEach(configure);

    describe('the browser-log shipper', () => {
        it('emits under ONLY what the closure wrote, leaving the shipping request intact', () => {
            const emitter = new BrowserLogEmitter();
            const browserPayload: Record<string, unknown> = {
                actionId: 'browser-action-77',
                // The browser also claims a userId. It is a TRUSTED key, so the loop cannot write it.
                userId: 'attacker-supplied',
            };

            RequestContext.run(() => {
                // The shipping request's own scope: a proven identity plus its own ids.
                RequestContext.putTrusted(USER_ID, 'real-user-42');
                RequestContext.putUntrusted(REQUEST_ID, 'shipping-request-1');
                RequestContext.putUntrusted(ACTION_ID, 'shipping-action-1');

                const fields = emitter.emit(browserPayload, HeaderRegistry.get().getLoggedKeys());

                // (b) the detached scope did NOT inherit the outer values...
                expect(fields.get('requestId')).toBeUndefined();
                expect(fields.get('userId')).toBeUndefined();
                // ...it holds exactly what the closure wrote, from the browser's own snapshot.
                expect(fields.get('actionId')).toBe('browser-action-77');

                // (a) the outer scope is intact afterwards — same identity, same ids.
                expect(RequestContext.getTrusted(USER_ID)).toBe('real-user-42');
                expect(RequestContext.getUntrusted(REQUEST_ID)).toBe('shipping-request-1');
                expect(RequestContext.getUntrusted(ACTION_ID)).toBe('shipping-action-1');
            });
        });

        it('(c) a browser-supplied payload cannot FABRICATE a trusted value', () => {
            const emitter = new BrowserLogEmitter();
            const browserPayload: Record<string, unknown> = { userId: 'attacker-supplied' };

            RequestContext.run(() => {
                RequestContext.putTrusted(USER_ID, 'real-user-42');
                const fields = emitter.emit(browserPayload, HeaderRegistry.get().getLoggedKeys());
                // The browser proved nothing, so this code has no grounds to claim proof — and the
                // compiler holds it to that: the loop's only write verb is putUntrusted, which does not
                // accept a trusted key. Nothing here says trusted keys are unwritable; see the next test.
                expect(fields.get('userId')).toBeUndefined();
                // And the browser's claim did not leak back into the request that carried it.
                expect(RequestContext.getTrusted(USER_ID)).toBe('real-user-42');
            });
        });

        it('putTrusted works inside a detached scope, for a value the caller ACTUALLY proved', () => {
            // The signed-webhook shape: something out of band (a verified JWT, a Twilio/WhatsApp
            // signature -> phone number -> userId lookup) proved this, so claiming proof is honest.
            // Trust is about whether the value can have been tampered with, NOT about secrecy —
            // userId is trusted AND fully logged, which is the intended combination.
            RequestContext.run(() => {
                RequestContext.putTrusted(USER_ID, 'shipping-request-user');
                RequestContext.runDetachedScope(() => {
                    expect(RequestContext.getTrusted(USER_ID)).toBeUndefined();
                    RequestContext.putTrusted(USER_ID, 'proven-out-of-band-user');
                    expect(RequestContext.getTrusted(USER_ID)).toBe('proven-out-of-band-user');
                    expect(RequestContext.buildLogFields().get('userId')).toBe('proven-out-of-band-user');
                });
                expect(RequestContext.getTrusted(USER_ID)).toBe('shipping-request-user');
            });
        });

        it('every line of ONE batch gets its OWN scope — the whole point of the feature', () => {
            const emitter = new BrowserLogEmitter();
            const keys = (): AnyContextKey[] => HeaderRegistry.get().getLoggedKeys();

            RequestContext.run(() => {
                RequestContext.putUntrusted(ACTION_ID, 'shipping-action-1');
                const first = emitter.emit({ actionId: 'action-a' }, keys());
                const second = emitter.emit({ actionId: 'action-b' }, keys());
                expect(first.get('actionId')).toBe('action-a');
                expect(second.get('actionId')).toBe('action-b');
                expect(RequestContext.getUntrusted(ACTION_ID)).toBe('shipping-action-1');
            });
        });
    });

    describe('the scope itself', () => {
        it('starts EMPTY even when opened inside a populated scope', () => {
            RequestContext.run(() => {
                RequestContext.putTrusted(USER_ID, 'real-user-42');
                RequestContext.putUntrusted(ACTION_ID, 'outer');
                RequestContext.runDetachedScope(() => {
                    expect(RequestContext.isActive()).toBe(true);
                    expect(RequestContext.getTrusted(USER_ID)).toBeUndefined();
                    expect(RequestContext.getUntrusted(ACTION_ID)).toBeUndefined();
                });
            });
        });

        it('MAY nest, where run() throws — and run() names it in the refusal', () => {
            RequestContext.run(() => {
                expect(() => RequestContext.run(() => undefined)).toThrow(/runDetachedScope/);
                RequestContext.runDetachedScope(() => {
                    RequestContext.runDetachedScope(() => {
                        RequestContext.putUntrusted(ACTION_ID, 'innermost');
                    });
                    expect(RequestContext.getUntrusted(ACTION_ID)).toBeUndefined();
                });
            });
        });

        it('works with NO enclosing scope at all', () => {
            expect(RequestContext.isActive()).toBe(false);
            RequestContext.runDetachedScope(() => {
                RequestContext.putUntrusted(ACTION_ID, 'standalone');
                expect(RequestContext.getUntrusted(ACTION_ID)).toBe('standalone');
            });
            expect(RequestContext.isActive()).toBe(false);
        });

        it('restores the enclosing scope when the closure THROWS', () => {
            RequestContext.run(() => {
                RequestContext.putUntrusted(ACTION_ID, 'outer');
                expect(() =>
                    RequestContext.runDetachedScope(() => {
                        RequestContext.putUntrusted(ACTION_ID, 'inner');
                        throw new Error('emit blew up');
                    }),
                ).toThrow('emit blew up');
                expect(RequestContext.getUntrusted(ACTION_ID)).toBe('outer');
            });
        });

        it('follows awaits inside the closure, and returns what the closure returns', async () => {
            await RequestContext.run(async () => {
                RequestContext.putUntrusted(ACTION_ID, 'outer');
                const result = await RequestContext.runDetachedScope(async () => {
                    RequestContext.putUntrusted(ACTION_ID, 'inner');
                    await Promise.resolve();
                    // Still the detached scope on the far side of the await.
                    return RequestContext.getUntrusted(ACTION_ID);
                });
                expect(result).toBe('inner');
                expect(RequestContext.getUntrusted(ACTION_ID)).toBe('outer');
            });
        });
    });
});
