import { inject, optional } from 'inversify';
import { provideFrameworkSingleton, RequestContext } from '@webpieces/core-context';
import { ApiForbiddenError, AuthorizationDeclaration, AuthorizationRequirement, AuthorizationType, ContextKey, WebpiecesCoreHeaders } from '@webpieces/core-util';

/** An application validates its own policy; the framework supplies no organization semantics. */
export abstract class AuthorizationHook<TPolicy> {
    // webpieces-disable no-any-unknown -- runtime application policy must be validated rather than cast to its generic type
    abstract validatePolicy(value: unknown): TPolicy;
    abstract authorize(policy: TPolicy): Promise<void>;

    // webpieces-disable no-any-unknown -- closes the validated generic value before the framework erases its type
    compile(value: unknown): CompiledAuthorizationPolicy {
        const policy = this.validatePolicy(value);
        return new CompiledAuthorizationPolicy(() => this.authorize(policy));
    }
}

export class CompiledAuthorizationPolicy {
    constructor(private readonly evaluation: () => Promise<void>) {}

    authorize(): Promise<void> {
        return this.evaluation();
    }
}

// webpieces-disable no-symbol-di-tokens -- optional application hook must not be auto-bound by the framework container
export const AUTHORIZATION_HOOK = Symbol.for('AuthorizationHook');

/** Current-hop machine proof is context-only; delegated headers never create it. */
export class VerifiedMachineCaller {
    private readonly scopeIdentity = RequestContext.activeScopeIdentity();

    isCurrentHop(): boolean {
        return this.scopeIdentity === RequestContext.activeScopeIdentity();
    }
    constructor(public readonly mechanism: string, public readonly identity: string) {
        if (!mechanism.trim() || !identity.trim()) throw new Error('Verified machine evidence must name its mechanism and identity.');
    }
}

export const VERIFIED_MACHINE_CALLER = ContextKey.trusted<VerifiedMachineCaller>(
    'verifiedMachineCaller', 'established by the successful current-hop credential verifier', undefined, false, false,
);

/** One compiled policy governs receiving endpoints, MCP visibility, and served documents. */
@provideFrameworkSingleton()
export class AuthorizationService {
    private readonly compiled = new WeakMap<object, CompiledAuthorizationPolicy>();

    constructor(
        @optional() @inject(AUTHORIZATION_HOOK) private readonly hook?: AuthorizationHook<never>,
    ) {}

    // webpieces-disable no-any-unknown -- the custom hook validates erased application policy at startup
    validate(requirement: AuthorizationRequirement<unknown>): void {
        AuthorizationDeclaration.validate(requirement);
        if (requirement.authType !== AuthorizationType.CUSTOM || this.compiled.has(requirement)) return;
        if (!this.hook) throw new Error('@WpAuthorization CUSTOM requires a bound AuthorizationHook (AUTHORIZATION_HOOK).');
        this.compiled.set(requirement, this.hook.compile(requirement.appPolicy));
    }

    // webpieces-disable no-any-unknown -- standard branches are narrowed; custom policies execute their compiled typed closure
    async authorize(requirement: AuthorizationRequirement<unknown>): Promise<void> {
        this.validate(requirement);
        const userId = RequestContext.getTrusted(WebpiecesCoreHeaders.USER_ID);
        const isUser = typeof userId === 'string' && userId.trim().length > 0;
        const machine = RequestContext.getTrusted(VERIFIED_MACHINE_CALLER);
        const isMachine = machine instanceof VerifiedMachineCaller && machine.isCurrentHop();
        switch (requirement.authType) {
            case AuthorizationType.ANONYMOUS: return;
            case AuthorizationType.ALL_USERS:
                if (isUser) return;
                break;
            case AuthorizationType.SERVICE_ONLY:
                if (isMachine) return;
                break;
            case AuthorizationType.USERS_OR_SERVICES:
                if (isUser || isMachine) return;
                break;
            case AuthorizationType.ROLES:
                if (isUser && requirement.roles.some((role: string) => CanonicalUserRoles.read().includes(role))) return;
                break;
            case AuthorizationType.CUSTOM: {
                const policy = this.compiled.get(requirement);
                if (!policy) throw new Error('CUSTOM authorization was not compiled at startup.');
                await policy.authorize();
                return;
            }
        }
        throw new ApiForbiddenError(`Caller does not satisfy ${requirement.authType} authorization.`);
    }
}

/** Canonical roles use a JSON string array, including [] for a verified user with no roles. */
export class CanonicalUserRoles {
    // webpieces-disable no-function-outside-class -- stateless contract validation or scope metadata reader used before DI registration
    static read(): readonly string[] {
        const encoded = RequestContext.getTrusted(WebpiecesCoreHeaders.USER_ROLES);
        if (encoded === undefined) throw new ApiForbiddenError('Verified user roles are missing.');
        // webpieces-disable no-any-unknown -- JSON is validated before it becomes canonical roles
        const value: unknown = JSON.parse(encoded);
        if (!Array.isArray(value) || !value.every((role: unknown) => typeof role === 'string' && role.trim().length > 0)) {
            throw new ApiForbiddenError('Canonical user roles must be a JSON string array.');
        }
        return value as string[];
    }
}
