import { OpenApiImportError } from '../OpenApiImportError';
import { JsonFile } from './JsonFile';
import { SpecNode } from './SpecNode';

/** The verbs `@Endpoint` accepts, lower-case as an OpenAPI path item keys them. */
const VERBS: readonly string[] = ['get', 'post', 'put', 'patch', 'delete'];

/** ONE documented path or query parameter. */
export class SpecParameter {
    constructor(
        readonly name: string,
        readonly required: boolean,
        readonly description: string | undefined,
        readonly schema: SpecNode,
    ) {}
}

/** ONE vendor operation, read out of the spec with every local `$ref` resolved one level. */
export class SpecOperation {
    constructor(
        readonly operationId: string,
        /** Upper-case: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`. */
        readonly verb: string,
        readonly path: string,
        readonly summary: string | undefined,
        readonly description: string | undefined,
        /** In the order their `{placeholders}` appear in {@link path}. */
        readonly pathParameters: readonly SpecParameter[],
        readonly queryParameters: readonly SpecParameter[],
        /** The `application/json` request body schema, when the operation documents one. */
        readonly requestBody: SpecNode | undefined,
        /** The `application/json` schema of the lowest documented 2xx response, if any. */
        readonly responseBody: SpecNode | undefined,
        /** That response's description — the generated `@returns`. */
        readonly responseDescription: string | undefined,
    ) {}
}

/**
 * The vendor's OpenAPI 3.0/3.1 JSON document. Only what the importer needs: find an operation by
 * operationId, and resolve a LOCAL `$ref` (`#/components/...`). A remote `$ref` is refused.
 */
export class VendorSpec {
    private constructor(
        readonly file: string,
        readonly root: SpecNode,
    ) {}

    // webpieces-disable no-function-outside-class -- static factory: reading the file IS constructing the spec
    static load(file: string): VendorSpec {
        const root = new JsonFile().read(file, 'OpenAPI spec', 'Point "spec" in the import file at the vendor\'s OpenAPI JSON.');
        const version = root.text('openapi');
        if (version === undefined || !/^3\.[01]\./.test(version)) {
            throw new OpenApiImportError(
                `the spec declares openapi '${version ?? '(none)'}', not 3.0.x or 3.1.x`,
                file,
                'Convert a Swagger 2.0 document to OpenAPI 3 first (e.g. with swagger2openapi).',
            );
        }
        return new VendorSpec(file, root);
    }

    /** The node a `$ref` points at, or the node itself. Follows chained refs. */
    deref(node: SpecNode): SpecNode {
        let current = node;
        for (let hops = 0; hops < 32; hops++) {
            const ref = current.text('$ref');
            if (ref === undefined) return current;
            current = this.resolve(ref);
        }
        throw new OpenApiImportError('a $ref chain does not terminate', this.file, 'Fix the circular $ref in the spec.');
    }

    /** The node at a local JSON pointer (`#/components/schemas/Item`). */
    resolve(ref: string): SpecNode {
        if (!ref.startsWith('#/')) {
            throw new OpenApiImportError(`'${ref}' is not a local $ref`, this.file, 'Bundle the spec into one self-contained document first.');
        }
        let current = this.root;
        for (const step of ref.slice(2).split('/')) {
            current = current.at(step.replace(/~1/g, '/').replace(/~0/g, '~'));
        }
        if (!current.isPresent()) {
            throw new OpenApiImportError(`'${ref}' resolves to nothing`, this.file, 'Fix the dangling $ref in the spec.');
        }
        return current;
    }

    operation(operationId: string): SpecOperation {
        const paths = this.root.at('paths');
        for (const route of paths.keys()) {
            const item = paths.at(route);
            for (const verb of item.keys()) {
                const node = item.at(verb);
                if (node.text('operationId') !== operationId) continue;
                if (!VERBS.includes(verb)) {
                    throw new OpenApiImportError(
                        `operation '${operationId}' is ${verb.toUpperCase()}, which @Endpoint does not support`,
                        this.file,
                        'Remove it from "operations"; only GET, POST, PUT, PATCH and DELETE can be generated.',
                    );
                }
                return this.read(operationId, verb.toUpperCase(), route, item, node);
            }
        }
        throw new OpenApiImportError(
            `operation '${operationId}' is not in the spec`,
            this.file,
            'Fix the operationId in "operations" — it must match an operationId in the spec exactly.',
        );
    }

    private read(operationId: string, verb: string, route: string, item: SpecNode, node: SpecNode): SpecOperation {
        const parameters = [...item.list('parameters'), ...node.list('parameters')].map((p: SpecNode) => this.deref(p));
        const byLocation = (location: string): SpecParameter[] => {
            const found = new Map<string, SpecParameter>();
            for (const parameter of parameters) {
                const name = parameter.text('name');
                if (parameter.text('in') !== location || name === undefined) continue;
                found.set(name, new SpecParameter(name, parameter.flag('required') === true, parameter.text('description'), parameter.at('schema')));
            }
            return [...found.values()];
        };
        const pathParameters = byLocation('path');
        const placeholders = [...route.matchAll(/\{([^{}]+)\}/g)].map((match: RegExpMatchArray) => match[1]);
        const ordered = placeholders.map((name: string) =>
            pathParameters.find((parameter: SpecParameter) => parameter.name === name) ??
            new SpecParameter(name, true, undefined, new SpecNode({ type: 'string' })),
        );
        const response = this.successResponse(node);
        return new SpecOperation(
            operationId,
            verb,
            route,
            node.text('summary'),
            node.text('description'),
            ordered,
            byLocation('query'),
            this.requestBody(operationId, verb, node),
            response === undefined ? undefined : this.jsonSchema(response),
            response?.text('description'),
        );
    }

    private requestBody(operationId: string, verb: string, node: SpecNode): SpecNode | undefined {
        const body = this.deref(node.at('requestBody'));
        if (!body.isPresent()) return undefined;
        const schema = this.jsonSchema(body);
        if (schema === undefined) {
            throw new OpenApiImportError(
                `operation '${operationId}' documents a request body with no application/json content`,
                this.file,
                'Only JSON bodies can be generated; remove the operation from "operations".',
            );
        }
        if (verb === 'GET' || verb === 'DELETE') {
            throw new OpenApiImportError(
                `operation '${operationId}' is ${verb} with a request body, which @Endpoint cannot send`,
                this.file,
                'Remove the operation from "operations"; GET and DELETE never carry a body.',
            );
        }
        return schema;
    }

    /** The lowest-numbered documented 2xx response (2XX last), or undefined. */
    private successResponse(node: SpecNode): SpecNode | undefined {
        const responses = node.at('responses');
        const codes = responses
            .keys()
            .filter((code: string) => /^2(\d\d|XX)$/i.test(code))
            .sort();
        return codes.length === 0 ? undefined : this.deref(responses.at(codes[0]));
    }

    private jsonSchema(holder: SpecNode): SpecNode | undefined {
        const content = holder.at('content');
        const media = content.keys().find((type: string) => /^application\/(.+\+)?json/i.test(type));
        if (media === undefined) return undefined;
        const schema = content.at(media).at('schema');
        return schema.isPresent() ? schema : undefined;
    }
}
