import { ApiForbiddenError, ApiImplementationError, RouteMetadata, toError } from '@webpieces/core-util';
import { AuthorizationService } from './AuthorizationHook';
import { AuthenticatedCallerContext } from './AuthenticatedCallerContext';

export type ApiDocumentValue = string | number | boolean | null | ApiDocumentValue[] | ApiDocumentObject;
export type ApiDocumentObject = { [key: string]: ApiDocumentValue };

/** Project a private bundled catalog afresh inside each authenticated docs request. */
export class AuthorizedApiDocument {
    private readonly routes = new Map<string, RouteMetadata>();
    private readonly methods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

    constructor(private readonly policy: AuthorizationService, routes: readonly RouteMetadata[]) {
        for (const route of routes) {
            if (!route.authorization || !route.apiClass) throw new ApiImplementationError('Document routes require canonical receiving endpoint metadata.');
            policy.validate(route.authorization);
            const id = `${route.apiClass.name}_${route.methodName}`;
            if (this.routes.has(id)) throw new ApiImplementationError(`Duplicate document operation ${id}.`);
            this.routes.set(id, route);
        }
    }

    async project(catalog: ApiDocumentObject): Promise<ApiDocumentObject> {
        if (!AuthenticatedCallerContext.hasCompletedAuthentication()) throw new ApiImplementationError('Serve API documents inside completed authentication.');
        const document = structuredClone(catalog);
        const paths = this.object(document['paths']);
        const tags = new Set<string>();
        for (const [path, value] of Object.entries(paths)) {
            const item = this.object(value);
            for (const method of Object.keys(item)) {
                if (!this.methods.includes(method)) continue;
                const operation = this.object(item[method]);
                const id = operation['operationId'];
                const route = typeof id === 'string' ? this.routes.get(id) : undefined;
                if (!route?.authorization || route.path.replace(/:([A-Za-z_]\w*)/g, '{$1}') !== path || route.httpMethod.toLowerCase() !== method) throw new ApiImplementationError(`Document operation ${String(id)} has no matching receiving endpoint policy.`);
                if (!(await this.permits(route))) { delete item[method]; continue; }
                const names = operation['tags'];
                if (Array.isArray(names)) for (const name of names) if (typeof name === 'string') tags.add(name);
            }
            if (!Object.keys(item).some((method: string) => this.methods.includes(method))) delete paths[path];
        }
        delete document['webhooks'];
        if (Array.isArray(document['tags'])) document['tags'] = document['tags'].filter((tag: ApiDocumentValue) => {
            const name = this.object(tag)['name'];
            return typeof name === 'string' && tags.has(name);
        });
        this.pruneComponents(document);
        return document;
    }

    private async permits(route: RouteMetadata): Promise<boolean> {
        if (!route.authorization) throw new ApiImplementationError('Missing document authorization.');
        // webpieces-disable no-unmanaged-exceptions -- document projection boundary turns only explicit policy denials into omitted operations; invariant failures propagate
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- explicit policy denials are omitted document operations; other failures propagate
        try {
            await this.policy.authorize(route.authorization);
            return true;
        } catch (err: unknown) {
            const error = toError(err);
            if (error instanceof ApiForbiddenError) return false;
            throw error;
        }
    }

    private pruneComponents(document: ApiDocumentObject): void {
        if (document['components'] === undefined) return;
        const definitions = this.object(document['components']);
        const reached = new Set<string>();
        const pending: string[] = [];
        const roots = { ...document };
        delete roots['components'];
        this.references(roots, pending);
        while (pending.length) {
            const ref = pending.pop()!;
            if (reached.has(ref)) continue;
            reached.add(ref);
            const match = /^#\/components\/([^/]+)\/([^/]+)$/.exec(ref);
            if (!match) throw new ApiImplementationError('Caller documents require a bundled catalog with local component references.');
            const group = this.object(definitions[match[1]]);
            const name = match[2].replace(/~1/g, '/').replace(/~0/g, '~');
            if (group[name] === undefined) throw new ApiImplementationError(`Document reference ${ref} is missing.`);
            this.references(group[name], pending);
        }
        for (const [kind, value] of Object.entries(definitions)) {
            const group = this.object(value);
            for (const name of Object.keys(group)) {
                const encoded = name.replace(/~/g, '~0').replace(/\//g, '~1');
                if (!reached.has(`#/components/${kind}/${encoded}`)) delete group[name];
            }
            if (!Object.keys(group).length) delete definitions[kind];
        }
    }

    private references(value: ApiDocumentValue, pending: string[]): void {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) { for (const child of value) this.references(child, pending); return; }
        if (typeof value['$ref'] === 'string') pending.push(value['$ref']);
        const security = value['security'];
        if (Array.isArray(security)) for (const requirement of security) {
            for (const name of Object.keys(this.object(requirement))) pending.push(`#/components/securitySchemes/${name}`);
        }
        for (const child of Object.values(value)) this.references(child, pending);
    }

    private object(value: ApiDocumentValue | undefined): ApiDocumentObject {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiImplementationError('API document requires object values.');
        return value;
    }
}
