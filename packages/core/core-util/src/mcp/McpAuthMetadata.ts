import 'reflect-metadata';
import { JwtRequirement } from '../http/auth-mode';
import { METADATA_KEYS } from '../http/decorators';

/** Authorization policy for the verified MCP user principal, independent of HTTP hop auth. */
export class WpMcpJwtAuthMetadata {
    constructor(public readonly requirement: JwtRequirement) {}
}

// webpieces-disable no-function-outside-class -- authorization decorator factory
export function WpMcpAuthJwt(requirement: JwtRequirement): MethodDecorator {
    return (target: object, propertyKey: string | symbol): void => {
        const apiClass = target.constructor;
        const methodName = String(propertyKey);
        if (Reflect.hasMetadata(METADATA_KEYS.MCP_AUTH_JWT, apiClass, methodName)) {
            throw new Error(`Only one @WpMcpAuthJwt may decorate ${apiClass.name}.${methodName}.`);
        }
        Reflect.defineMetadata(
            METADATA_KEYS.MCP_AUTH_JWT,
            new WpMcpJwtAuthMetadata(requirement),
            apiClass,
            methodName,
        );
    };
}

// webpieces-disable no-function-outside-class -- metadata reader paired with WpMcpAuthJwt
export function getWpMcpAuthJwt(
    apiClass: Function,
    methodName: string,
): WpMcpJwtAuthMetadata | undefined {
    return Reflect.getMetadata(METADATA_KEYS.MCP_AUTH_JWT, apiClass, methodName) as
        | WpMcpJwtAuthMetadata
        | undefined;
}
