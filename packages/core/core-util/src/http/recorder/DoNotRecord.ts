import 'reflect-metadata';

const DO_NOT_RECORD_KEY = 'webpieces:do-not-record';

/**
 * @DoNotRecord - Property decorator marking a DTO field that must be omitted
 * from recorded fixtures (port of Java @DoNotRecord).
 *
 * Use for volatile or sensitive fields (timestamps, generated ids, secrets)
 * that would make recorded assertions flaky or leak data:
 *
 * ```typescript
 * export class FetchValueResponse {
 *     value?: string;
 *     @DoNotRecord()
 *     timestamp?: number;   // omitted from fixtures + generated assertions
 * }
 * ```
 */
export function DoNotRecord(): PropertyDecorator {
    return (target: object, propertyKey: string | symbol): void => {
        const existing: string[] = Reflect.getMetadata(DO_NOT_RECORD_KEY, target.constructor) || [];
        existing.push(String(propertyKey));
        Reflect.defineMetadata(DO_NOT_RECORD_KEY, existing, target.constructor);
    };
}

/**
 * Field names marked @DoNotRecord on the instance's class (empty for plain
 * objects / interface-typed DTOs, which cannot carry decorators).
 */
export function getDoNotRecordFields(instance: object): string[] {
    if (!instance || typeof instance !== 'object') {
        return [];
    }
    return Reflect.getMetadata(DO_NOT_RECORD_KEY, instance.constructor) || [];
}
