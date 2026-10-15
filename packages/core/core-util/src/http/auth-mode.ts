import type { AnyContextKey } from '../ContextKey';

/**
 * WHERE one api-key credential rides.
 *
 * A header credential names the {@link AnyContextKey ContextKey} that carries it — NEVER a header-name
 * string. The key's `httpHeader` is the wire name, so the ONE definition of each header (the
 * ContextKey) is reused on every surface: `RequestContext` put/get, the client/server header
 * transfer, this declaration, and the published OpenAPI document. A string here was a second copy a
 * rename left stale (#1249). The key MUST declare an `httpHeader` — {@link AuthDeclaration} refuses
 * one that does not, and the OpenAPI generator reads the header name off the key's
 * `ContextKey.trusted(...)` / `ContextKey.untrusted(...)` definition.
 */
export type ApiKeyCredential =
    | { in: 'header'; key: AnyContextKey; description?: string }
    | { in: 'bearer'; key?: never; description?: string };

export type ApiKeyCredentials = readonly [ApiKeyCredential, ...ApiKeyCredential[]];

/** One concrete mechanism; user policy belongs exclusively to WpAuthorization. */
export type AuthMethod =
    | { kind: 'jwt' }
    | { kind: 'oidc'; callers: readonly string[] }
    | { kind: 'shared-secret'; secretKey: string }
    | { kind: 'webhook'; name: string }
    | { kind: 'apikey'; regime: string; credentials: ApiKeyCredentials };

export type AuthMethods = readonly [AuthMethod, ...AuthMethod[]];
export type AuthMode = AuthMethod | { kind: 'public' };

/** Alternatives remain unresolved until a concrete mechanism is chosen for this hop. */
export class AuthMeta {
    readonly methods: readonly [AuthMode, ...AuthMode[]];

    constructor(
        methods: readonly [AuthMode, ...AuthMode[]],
        public readonly publicReason: string | undefined,
    ) {
        this.methods = methods;
        AuthDeclaration.validate(this);
        this.methods = Object.freeze(methods.map((method: AuthMode) => AuthMeta.snapshot(method))) as readonly [AuthMode, ...AuthMode[]];
        Object.freeze(this);
    }

    // webpieces-disable no-function-outside-class -- stateless contract validation or scope metadata reader used before DI registration
    private static snapshot(method: AuthMode): AuthMode {
        switch (method.kind) {
            case 'oidc': return Object.freeze({ ...method, callers: Object.freeze([...method.callers]) });
            case 'apikey': return Object.freeze({ ...method, credentials: Object.freeze(method.credentials.map((credential: ApiKeyCredential) => Object.freeze({ ...credential }))) as ApiKeyCredentials });
            default: return Object.freeze({ ...method });
        }
    }
}

export class AuthDeclaration {
    // webpieces-disable no-function-outside-class -- stateless contract validation or scope metadata reader used before DI registration
    static validate(meta: AuthMeta): void {
        if (!Array.isArray(meta.methods) || meta.methods.length === 0) throw new Error('@WpAuth requires a nonempty methods tuple.');
        const kinds = new Set<string>();
        for (const method of meta.methods) {
            if (!method || typeof method !== 'object' || kinds.has(method.kind)) throw new Error('@WpAuth rejects duplicate or invalid credential methods.');
            kinds.add(method.kind);
            this.validateMethod(method);
        }
        if (kinds.has('public')) {
            if (meta.methods.length !== 1 || typeof meta.publicReason !== 'string' || !meta.publicReason.trim()) {
                throw new Error('Public auth must be declared separately with @WpAuthPublic(reason).');
            }
        } else if (meta.publicReason !== undefined) throw new Error('Protected @WpAuth rejects public reasons.');
    }

    // webpieces-disable no-function-outside-class -- stateless contract validation or scope metadata reader used before DI registration
    private static validateMethod(method: AuthMode): void {
        let keys: readonly string[];
        switch (method.kind) {
            case 'jwt':
            case 'public': keys = ['kind']; break;
            case 'oidc':
                keys = ['kind', 'callers'];
                if (!Array.isArray(method.callers) || !method.callers.every((caller: string) => typeof caller === 'string' && caller.trim().length > 0)) throw new Error('oidc(...) requires valid caller names.');
                break;
            case 'shared-secret':
                keys = ['kind', 'secretKey'];
                this.requireText(method.secretKey, 'sharedSecret'); break;
            case 'webhook':
                keys = ['kind', 'name'];
                this.requireText(method.name, 'webhook'); break;
            case 'apikey':
                keys = ['kind', 'regime', 'credentials'];
                this.requireText(method.regime, 'apiKey');
                if (!Array.isArray(method.credentials) || !method.credentials.length) throw new Error('apiKey(...) requires a nonempty credentials tuple.');
                for (const credential of method.credentials) {
                    if (credential.in === 'header') this.requireHeaderKey(credential.key);
                    else if (credential.in !== 'bearer' || Object.hasOwn(credential, 'key')) throw new Error('Invalid API-key credential location.');
                }
                break;
            default: throw new Error('Unknown @WpAuth method; use jwt/oidc/sharedSecret/webhook/apiKey descriptors.');
        }
        for (const key of Object.keys(method)) {
            if (!keys.includes(key)) throw new Error(`Auth method rejects '${key}'; operation policy belongs in @WpAuthorization.`);
        }
    }

    /**
     * A header credential's key must be a ContextKey that rides the wire. `httpHeader` is optional on
     * ContextKey itself (most keys never leave the process), and the factories' explicit value-type
     * argument (`ContextKey.untrusted<string>(...)`) stops TypeScript inferring whether one was
     * passed, so the type cannot say "a key WITH a header". It is checked once, when the contract is
     * decorated, and the OpenAPI generator refuses the same key statically.
     */
    // webpieces-disable no-function-outside-class -- stateless contract validation or scope metadata reader used before DI registration
    private static requireHeaderKey(key: AnyContextKey | undefined): void {
        if (!key || typeof key !== 'object' || typeof key.name !== 'string') {
            throw new Error("apiKey header credential requires `key`: the ContextKey carrying it, e.g. { in: 'header', key: MyKeys.API_KEY }.");
        }
        if (typeof key.httpHeader !== 'string' || !key.httpHeader.trim()) {
            throw new Error(`apiKey header credential key '${key.name}' declares no httpHeader; define it with ContextKey.trusted(name, provenance, '<header>') or ContextKey.untrusted(name, '<header>').`);
        }
    }

    // webpieces-disable no-function-outside-class -- stateless contract validation or scope metadata reader used before DI registration
    private static requireText(value: string, label: string): void {
        if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} requires a nonempty name.`);
    }
}

// webpieces-disable no-function-outside-class -- canonical credential descriptor factory
export function jwt(): AuthMethod { return { kind: 'jwt' }; }
// webpieces-disable no-function-outside-class -- canonical credential descriptor factory
export function oidc(...callers: string[]): AuthMethod { return { kind: 'oidc', callers }; }
// webpieces-disable no-function-outside-class -- canonical credential descriptor factory
export function sharedSecret(secretKey: string): AuthMethod { return { kind: 'shared-secret', secretKey }; }
// webpieces-disable no-function-outside-class -- canonical credential descriptor factory
export function webhook(name: string): AuthMethod { return { kind: 'webhook', name }; }
// webpieces-disable no-function-outside-class -- canonical credential descriptor factory
export function apiKey(regime: string, credentials: ApiKeyCredentials): AuthMethod { return { kind: 'apikey', regime, credentials }; }
