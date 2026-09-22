import 'reflect-metadata';

/**
 * The three facts about a NUMBER that TypeScript cannot state, plus the type alias that states the
 * first one without a decorator at all.
 *
 * ## Why any of this exists
 *
 * TypeScript has ONE numeric type. `limit: number` cannot say whether `1.5` is legal, and a
 * published schema that says `type: number` where the server means `integer` is wrong in a way no
 * test catches — the wrong value simply arrives one day. A bound is worse still: `minimum` and
 * `maximum` are policy, and policy has nowhere at all to live in a TypeScript type.
 *
 * ## `Integer` is the PREFERRED spelling, and `@WpInt()` is the other accepted one
 *
 * ```typescript
 * limit?: Integer;                 // PREFERRED — it COMPOSES: Integer[], Record<string, Integer>
 * @WpInt() limit?: number;         // also accepted
 * ```
 *
 * `Integer` is preferred because it composes: a decorator on `counts?: number[]` is ambiguous about
 * whether it describes the ARRAY or its ITEMS, which is the exact ambiguity that made the deleted
 * `WpDtoFieldOptions.arrayItems` argument unusable, while `Integer[]` and `Record<string, Integer>`
 * are not ambiguous about anything. `@WpInt()` stays for the field whose declared type you do not
 * want to change, and because a decorator needs a class to hang on where a type alias does not.
 *
 * Two spellings of one thing is normally a shim this repo rejects (`.claude/rules/no-backwards-compat.md`
 * shape #1). This pair is a deliberate exception, authorized by Dean in design review on 2026-09-22
 * and recorded in issue #981 and in `packages/docs/api-doc-model/responsibilities.md`. It is NOT
 * justified by an existing release — nothing has ever shipped `@WpInt` — the reason is ergonomic.
 *
 * ## They are read by the COMPILER, and the metadata is a by-product
 *
 * `@webpieces/api-doc-model` reads these off the SOURCE with the TypeScript compiler, because a
 * field's type is erased at runtime and reflection can therefore never see the shapes a partner-grade
 * document is made of. The metadata written below is what makes them ordinary decorators rather than
 * markers the runtime cannot see at all, and it is deliberately the same shape for all three: a map
 * from property name to the declared value.
 */

/**
 * INTEGER-ness, expressed in the type. `Integer` is `number` at runtime and everywhere TypeScript
 * looks — it is a DECLARATION for the document generator, which reads the written syntax rather than
 * the checker's answer, precisely so this alias survives to be read.
 */
export type Integer = number;

/** Metadata keys for the numeric field declarations, parallel to `METADATA_KEYS` in `decorators.ts`. */
export const NUMERIC_METADATA_KEYS = {
    /** property name -> true, for every `@WpInt()` field. */
    INT: 'webpieces:field-int',
    /** property name -> the declared minimum. */
    MIN: 'webpieces:field-min',
    /** property name -> the declared maximum. */
    MAX: 'webpieces:field-max',
};

/**
 * One metadata write, shared by all three decorators, so they cannot drift in shape.
 *
 * `value` is `number | boolean` because that is the whole of what these three declare: a bound, or
 * the fact of being an integer.
 */
// webpieces-disable no-function-outside-class -- decorator support; decorators are inherently module-scope
function record(
    key: string,
    target: object,
    propertyKey: string | symbol,
    value: number | boolean,
): void {
    const owner = typeof target === 'function' ? target : target.constructor;
    // webpieces-disable no-any-unknown -- reflect-metadata hands back whatever was stored; the values are ours and are narrowed by the signature above
    const existing: Record<string, unknown> = Reflect.getMetadata(key, owner) || {};
    existing[String(propertyKey)] = value;
    Reflect.defineMetadata(key, existing, owner);
}

/**
 * This numeric field holds an INTEGER. Prefer writing the type as {@link Integer}, which composes.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function WpInt(): PropertyDecorator {
    return (target: object, propertyKey: string | symbol) => {
        record(NUMERIC_METADATA_KEYS.INT, target, propertyKey, true);
    };
}

/**
 * The smallest value this field may hold. Policy, not type — on a non-numeric field it is a BUILD
 * FAILURE from the document generator rather than a silently dropped constraint, because dropping it
 * would publish a contract weaker than the one its author wrote down.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function WpMin(value: number): PropertyDecorator {
    return (target: object, propertyKey: string | symbol) => {
        record(NUMERIC_METADATA_KEYS.MIN, target, propertyKey, value);
    };
}

/** The largest value this field may hold. See {@link WpMin}. */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function WpMax(value: number): PropertyDecorator {
    return (target: object, propertyKey: string | symbol) => {
        record(NUMERIC_METADATA_KEYS.MAX, target, propertyKey, value);
    };
}
