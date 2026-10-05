import 'reflect-metadata';

export enum AuthorizationType {
    ALL_USERS = 'all-users',
    ROLES = 'roles',
    SERVICE_ONLY = 'service-only',
    USERS_OR_SERVICES = 'users-or-services',
    ANONYMOUS = 'anonymous',
    CUSTOM = 'custom',
}

export type AuthorizationRequirement<TPolicy = never> =
    | {
          authType: AuthorizationType.ALL_USERS | AuthorizationType.SERVICE_ONLY | AuthorizationType.USERS_OR_SERVICES;
          roles?: never;
          reason?: never;
          appPolicy?: never;
      }
    | {
          authType: AuthorizationType.ROLES;
          roles: readonly [string, ...string[]];
          reason?: never;
          appPolicy?: never;
      }
    | {
          authType: AuthorizationType.ANONYMOUS;
          reason: string;
          roles?: never;
          appPolicy?: never;
      }
    | {
          authType: AuthorizationType.CUSTOM;
          appPolicy: TPolicy;
          roles?: never;
          reason?: never;
      };

export const AUTHORIZATION_METADATA_KEY = 'webpieces:authorization';
export const AUTHORIZATION_METHODS_KEY = 'webpieces:authorization-methods';

/** Runtime checks also protect JavaScript and type-erased callers. */
export class AuthorizationDeclaration {
    // webpieces-disable no-any-unknown -- decorator policy is application-owned and validated before storage
    // webpieces-disable no-function-outside-class -- stateless contract validation or scope metadata reader used before DI registration
    static validate(value: AuthorizationRequirement<unknown>): void {
        if (!value || typeof value !== 'object' || !Object.values(AuthorizationType).includes(value.authType)) {
            throw new Error('@WpAuthorization requires a recognized AuthorizationType.');
        }
        const allowed = new Set(['authType']);
        if (value.authType === AuthorizationType.ROLES) allowed.add('roles');
        if (value.authType === AuthorizationType.ANONYMOUS) allowed.add('reason');
        if (value.authType === AuthorizationType.CUSTOM) allowed.add('appPolicy');
        for (const key of Object.keys(value)) {
            if (!allowed.has(key)) throw new Error(`@WpAuthorization ${value.authType} rejects '${key}'; application policy belongs in CUSTOM.appPolicy.`);
        }
        if (value.authType === AuthorizationType.ROLES &&
            (!Array.isArray(value.roles) || value.roles.length === 0 || value.roles.some((role: string) => typeof role !== 'string' || role.trim() === ''))) {
            throw new Error('@WpAuthorization ROLES requires a nonempty tuple of nonempty role names.');
        }
        if (value.authType === AuthorizationType.ANONYMOUS &&
            (typeof value.reason !== 'string' || value.reason.trim() === '')) {
            throw new Error('@WpAuthorization ANONYMOUS requires a nonempty reason.');
        }
        if (value.authType === AuthorizationType.CUSTOM && !Object.hasOwn(value, 'appPolicy')) {
            throw new Error('@WpAuthorization CUSTOM requires appPolicy and a bound AuthorizationHook.');
        }
    }
}

// webpieces-disable no-function-outside-class -- canonical TypeScript method decorator factory
export function WpAuthorization<TPolicy = never>(policy: AuthorizationRequirement<TPolicy>): MethodDecorator {
    AuthorizationDeclaration.validate(policy);
    return (target: object, propertyKey: string | symbol) => {
        if (propertyKey === undefined) throw new Error('@WpAuthorization is method-only.');
        const apiClass = target.constructor;
        if (Reflect.hasMetadata(AUTHORIZATION_METADATA_KEY, apiClass, propertyKey)) {
            throw new Error(`Duplicate @WpAuthorization on ${apiClass.name}.${String(propertyKey)}.`);
        }
        Reflect.defineMetadata(AUTHORIZATION_METADATA_KEY, Object.freeze(policy), apiClass, propertyKey);
        const methods = new Set<string>(Reflect.getMetadata(AUTHORIZATION_METHODS_KEY, apiClass) ?? []);
        methods.add(String(propertyKey));
        Reflect.defineMetadata(AUTHORIZATION_METHODS_KEY, [...methods], apiClass);
    };
}

// webpieces-disable no-function-outside-class -- canonical Reflect metadata reader; webpieces-disable no-any-unknown -- erased custom policy is validated by the application hook at startup
export function getAuthorization(apiClass: Function, methodName: string): AuthorizationRequirement<unknown> | undefined {
    return Reflect.getMetadata(AUTHORIZATION_METADATA_KEY, apiClass, methodName);
}
