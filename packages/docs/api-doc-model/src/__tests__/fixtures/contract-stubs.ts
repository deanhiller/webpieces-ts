/* eslint-disable */
/**
 * FIXTURE SUPPORT. Excluded from `tsconfig.lib.json`, so it ships in no build.
 *
 * The extractor matches webpieces decorators BY NAME on the syntax and imports none of them (see
 * `ApiDocExtractor`'s class doc), so a fixture contract needs decorators that merely EXIST. Declaring
 * them here rather than importing `@webpieces/core-util` is what proves the no-app-specific-import
 * constraint holds: if the extractor ever started needing the real decorator, these fixtures would
 * stop producing a model and the suite would say so.
 */

export type EndpointKind = 'rpc' | 'cloudtasks' | 'cron' | 'external';

/** INTEGER-ness, which TypeScript cannot express — it has one numeric type. The PREFERRED spelling. */
export type Integer = number;

export function ApiPath(_basePath: string): ClassDecorator {
    return () => undefined;
}

export function Endpoint(
    _path: string,
    _kind: EndpointKind,
    _options?: Record<string, unknown>,
): MethodDecorator {
    return () => undefined;
}

export function MaskLog(_fields: Record<string, string>): MethodDecorator {
    return () => undefined;
}

export function WpAuthPublic(): MethodDecorator {
    return () => undefined;
}

export function WpAuthJwt(_requirement: Record<string, unknown>): MethodDecorator {
    return () => undefined;
}

export function WpMcpTool(_options: Record<string, unknown>): MethodDecorator {
    return () => undefined;
}

export function WpMcpAuthJwt(_requirement: Record<string, unknown>): MethodDecorator {
    return () => undefined;
}

/** The OTHER accepted spelling of integer-ness — see `responsibilities.md`. */
export function WpInt(): PropertyDecorator {
    return () => undefined;
}

export function WpMin(_value: number): PropertyDecorator {
    return () => undefined;
}

export function WpMax(_value: number): PropertyDecorator {
    return () => undefined;
}

/** A path held in a constant, so the fixture exercises constant FOLDING across an import. */
export const SAVE_PATH = '/save';
