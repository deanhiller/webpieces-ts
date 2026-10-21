import * as ts from 'typescript';

export class SecurityPolicyShapeProblem {
    constructor(readonly code: string, readonly message: string) {}
}

/**
 * Every canonical credential descriptor and the uniqueness key it occupies in one @WpAuth: its credential
 * kind, except OIDC, which is keyed on kind plus `callerScope` exactly as the runtime `AuthDeclaration`
 * keys it. So `oidcSameProject()` and `oidcSvcs([...])` may pair on one endpoint, and two of either may not.
 */
const DESCRIPTOR_KEYS: ReadonlyMap<string, string> = new Map([
    ['jwt', 'jwt'],
    ['oidcSameProject', 'oidc:same-project'],
    ['oidcSvcs', 'oidc:services'],
    ['sharedSecret', 'shared-secret'],
    ['webhook', 'webhook'],
    ['apiKey', 'apikey'],
]);

/** Literal declarations must be inspectable; runtime registration additionally checks erased values. */
export class SecurityPolicyShapes {
    // webpieces-disable no-function-outside-class -- stateless contract validation or scope metadata reader used before DI registration
    static authentication(call: ts.CallExpression | null, named: ReadonlyMap<string, string>, namespaces: ReadonlySet<string>): readonly SecurityPolicyShapeProblem[] {
        const array = call?.arguments[0];
        if (!array || !ts.isArrayLiteralExpression(array) || !array.elements.length) {
            return [new SecurityPolicyShapeProblem('HTTP_AUTH_METHODS', '@WpAuth requires a nonempty inline array of canonical credential descriptors.')];
        }
        const seenKeys = new Set<string>();
        const problems: SecurityPolicyShapeProblem[] = [];
        for (const element of array.elements) {
            const name = ts.isCallExpression(element) ? this.canonicalName(element.expression, named, namespaces) : undefined;
            const key = name === undefined ? undefined : DESCRIPTOR_KEYS.get(name);
            if (!name || !key || seenKeys.has(key)) {
                problems.push(new SecurityPolicyShapeProblem('HTTP_AUTH_METHODS', '@WpAuth accepts unique jwt/oidcSameProject/oidcSvcs/sharedSecret/webhook/apiKey descriptors; public/locality are separate declarations.'));
            } else {
                seenKeys.add(key);
                if (ts.isCallExpression(element)) problems.push(...this.descriptor(name, element));
            }
        }
        return problems;
    }

    // webpieces-disable no-function-outside-class -- stateless contract validation or scope metadata reader used before DI registration
    private static descriptor(name: string, call: ts.CallExpression): readonly SecurityPolicyShapeProblem[] {
        if (name === 'jwt' && call.arguments.length) return [new SecurityPolicyShapeProblem('HTTP_AUTH_METHODS', 'jwt() takes no policy; put roles/application policy in @WpAuthorization.')];
        if (name === 'oidcSameProject' && call.arguments.length) return [new SecurityPolicyShapeProblem('HTTP_AUTH_METHODS', 'oidcSameProject() takes no arguments; name service accounts with oidcSvcs([...]) instead.')];
        if (name === 'oidcSvcs') return this.oidcServices(call);
        if (['sharedSecret', 'webhook', 'apiKey'].includes(name) && !call.arguments.length) return [new SecurityPolicyShapeProblem('HTTP_AUTH_METHODS', `${name}(...) requires its named credential configuration.`)];
        if (name === 'apiKey' && !call.arguments[1]) return [new SecurityPolicyShapeProblem('HTTP_AUTH_METHODS', 'apiKey(regime, credentials) requires a nonempty credentials tuple.')];
        if (name === 'apiKey' && ts.isArrayLiteralExpression(call.arguments[1]) && !call.arguments[1].elements.length) return [new SecurityPolicyShapeProblem('HTTP_AUTH_METHODS', 'apiKey credentials cannot be empty.')];
        return [];
    }

    /**
     * `oidcSvcs([...])` takes ONE list naming at least one service account. An inline list is checked here;
     * any other expression is left to the `OidcCallers` type and the runtime `AuthDeclaration` backstop.
     */
    // webpieces-disable no-function-outside-class -- stateless contract validation or scope metadata reader used before DI registration
    private static oidcServices(call: ts.CallExpression): readonly SecurityPolicyShapeProblem[] {
        const list = call.arguments[0];
        const blank = (element: ts.Expression): boolean => ts.isStringLiteral(element) && element.text.trim().length === 0;
        if (call.arguments.length !== 1 || !list || (ts.isArrayLiteralExpression(list) && (!list.elements.length || list.elements.some(blank)))) {
            return [new SecurityPolicyShapeProblem('HTTP_AUTH_METHODS', "oidcSvcs([...]) requires one nonempty list of service accounts; use oidcSameProject() for this GCP project's service accounts.")];
        }
        return [];
    }

    // webpieces-disable no-function-outside-class -- stateless contract validation or scope metadata reader used before DI registration
    static authorization(call: ts.CallExpression | null, isPublic: boolean, named: ReadonlyMap<string, string>, namespaces: ReadonlySet<string>): readonly SecurityPolicyShapeProblem[] {
        const object = call?.arguments[0];
        if (!object || !ts.isObjectLiteralExpression(object)) return [new SecurityPolicyShapeProblem('HTTP_AUTHORIZATION_POLICY', '@WpAuthorization requires an inline discriminated policy; opaque expressions are not proof of a secure declaration.')];
        const fields = new Map<string, ts.Expression>();
        for (const property of object.properties) {
            if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) return [new SecurityPolicyShapeProblem('HTTP_AUTHORIZATION_POLICY', 'Authorization policy cannot use spreads, computed fields, or shorthand values.')];
            if (fields.has(property.name.text)) return [new SecurityPolicyShapeProblem('HTTP_AUTHORIZATION_POLICY', 'Authorization policy contains duplicate fields.')];
            fields.set(property.name.text, property.initializer);
        }
        const type = this.authorizationType(fields.get('authType'), named, namespaces);
        const shape = this.validatePolicyFields(type, fields);
        if (shape.length) return shape;
        if (isPublic !== (type === 'ANONYMOUS')) return [new SecurityPolicyShapeProblem('HTTP_AUTHORIZATION_PAIRING', 'Pair @WpAuthPublic with ANONYMOUS; protected @WpAuth requires protected/CUSTOM authorization.')];
        return [];
    }

    // webpieces-disable no-function-outside-class -- stateless contract validation or scope metadata reader used before DI registration
    private static validatePolicyFields(type: string | undefined, fields: ReadonlyMap<string, ts.Expression>): readonly SecurityPolicyShapeProblem[] {
        if (!type || !['ALL_USERS', 'ROLES', 'SERVICE_ONLY', 'USERS_OR_SERVICES', 'ANONYMOUS', 'CUSTOM'].includes(type)) return [new SecurityPolicyShapeProblem('HTTP_AUTHORIZATION_POLICY', 'Declare a canonical AuthorizationType branch.')];
        const allowed = new Set(['authType']);
        if (type === 'ROLES') allowed.add('roles');
        if (type === 'ANONYMOUS') allowed.add('reason');
        if (type === 'CUSTOM') allowed.add('appPolicy');
        if ([...fields.keys()].some((key: string) => !allowed.has(key))) return [new SecurityPolicyShapeProblem('HTTP_AUTHORIZATION_POLICY', 'roles belongs only on ROLES, reason only on ANONYMOUS, and application fields only under CUSTOM.appPolicy.')];
        if (type === 'ROLES') {
            const roles = fields.get('roles');
            if (!roles || !ts.isArrayLiteralExpression(roles) || !roles.elements.length || !roles.elements.every((role: ts.Expression) => ts.isStringLiteral(role) && role.text.trim().length > 0)) return [new SecurityPolicyShapeProblem('HTTP_AUTHORIZATION_POLICY', 'ROLES requires a nonempty inline tuple of nonempty role strings.')];
        }
        if (type === 'ANONYMOUS') {
            const reason = fields.get('reason');
            if (!reason || !ts.isStringLiteral(reason) || !reason.text.trim()) return [new SecurityPolicyShapeProblem('HTTP_AUTHORIZATION_POLICY', 'ANONYMOUS requires a nonempty reason.')];
        }
        if (type === 'CUSTOM' && !fields.has('appPolicy')) return [new SecurityPolicyShapeProblem('HTTP_AUTHORIZATION_POLICY', 'CUSTOM requires appPolicy and a validating AuthorizationHook at startup.')];
        return [];
    }

    // webpieces-disable no-function-outside-class -- stateless contract validation or scope metadata reader used before DI registration
    private static authorizationType(expression: ts.Expression | undefined, named: ReadonlyMap<string, string>, namespaces: ReadonlySet<string>): string | undefined {
        if (!expression || !ts.isPropertyAccessExpression(expression) || this.canonicalName(expression.expression, named, namespaces) !== 'AuthorizationType') return undefined;
        return expression.name.text;
    }

    // webpieces-disable no-function-outside-class -- stateless contract validation or scope metadata reader used before DI registration
    private static canonicalName(expression: ts.Expression, named: ReadonlyMap<string, string>, namespaces: ReadonlySet<string>): string | undefined {
        if (ts.isIdentifier(expression)) return named.get(expression.text);
        if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && namespaces.has(expression.expression.text)) return expression.name.text;
        return undefined;
    }
}
