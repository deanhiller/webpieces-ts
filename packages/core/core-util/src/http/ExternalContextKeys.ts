import 'reflect-metadata';
import { AnyContextKey } from '../ContextKey';

/** Class-level keys: every endpoint of the contract sends them. */
const CLASS_KEYS = 'webpieces:external-context-keys:class';
/** Method-level keys, `methodName -> keys`: ADDED to the class-level ones for that method only. */
const METHOD_KEYS = 'webpieces:external-context-keys:method';

/**
 * `@ExternalContextKeys(...keys)` — the ONLY request-context keys an `EXTERNAL_OUTBOUND` client sends
 * to the outside system it calls.
 *
 * WHY a per-CONTRACT list and not a flag on the `ContextKey`: a global "send to vendors" flag would
 * send Toast's restaurant id to Clover. Which context a vendor may see is a fact about THAT vendor's
 * API, so it is declared on that vendor's contract. Without this, an outbound client sends nothing
 * of ours — not `x-request-id`, not any `x-webpieces-*` key, not an app's untrusted transferred keys —
 * because a vendor is somebody else's process.
 *
 * On the CLASS it applies to every endpoint; on a METHOD it ADDS keys for that method only. A listed
 * key with no value in the request context makes the client throw BEFORE any I/O: the vendor needs it
 * (it is how the call is routed, e.g. a merchant id), and a request without it is a bug in our code.
 * Every listed key must declare an `httpHeader` — that is its wire name.
 *
 * ```ts
 * @ApiPath('')
 * @ExternalContextKeys(WebpiecesCoreHeaders.REQUEST_ID)
 * export abstract class PartnerWebhookApi { ... }
 * ```
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function ExternalContextKeys(...keys: AnyContextKey[]): ClassDecorator & MethodDecorator {
    if (keys.length === 0) {
        throw new Error('@ExternalContextKeys(...) requires at least one ContextKey.');
    }
    for (const key of keys) {
        if (key.httpHeader === undefined || key.httpHeader === '') {
            throw new Error(
                `@ExternalContextKeys: ContextKey '${key.name}' declares no httpHeader, so it has no wire name to send it under.`,
            );
        }
    }
    // webpieces-disable no-any-unknown -- reflect-metadata decorator API requires any
    return (target: any, propertyKey?: string | symbol): void => {
        if (propertyKey === undefined) {
            Reflect.defineMetadata(CLASS_KEYS, [...keys], target);
            return;
        }
        const metadataTarget = typeof target === 'function' ? target : target.constructor;
        const all: Record<string, AnyContextKey[]> = {
            ...(Reflect.getMetadata(METHOD_KEYS, metadataTarget) ?? {}),
        };
        all[propertyKey as string] = [...keys];
        Reflect.defineMetadata(METHOD_KEYS, all, metadataTarget);
    };
}

/**
 * The keys one method sends: the class-level list, then the method's additions, de-duplicated.
 * Empty when the contract declares none.
 */
// webpieces-disable no-function-outside-class -- reflect-metadata reader paired with the decorator
export function getExternalContextKeys(apiClass: Function, methodName: string): AnyContextKey[] {
    const classKeys: AnyContextKey[] = Reflect.getMetadata(CLASS_KEYS, apiClass) ?? [];
    const methodKeys: AnyContextKey[] =
        (Reflect.getMetadata(METHOD_KEYS, apiClass) ?? {})[methodName] ?? [];
    const merged: AnyContextKey[] = [];
    for (const key of [...classKeys, ...methodKeys]) {
        if (!merged.includes(key)) merged.push(key);
    }
    return merged;
}

/** True when the class or any of its methods carries `@ExternalContextKeys`. */
// webpieces-disable no-function-outside-class -- reflect-metadata reader paired with the decorator
export function declaresExternalContextKeys(apiClass: Function): boolean {
    return (
        Reflect.hasMetadata(CLASS_KEYS, apiClass) ||
        Object.keys(Reflect.getMetadata(METHOD_KEYS, apiClass) ?? {}).length > 0
    );
}
