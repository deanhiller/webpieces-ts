import {
    ApiSpec,
    NamedSchema,
    OperationInfo,
    ResponseInfo,
    SecuritySchemeInfo,
    ServerInfo,
    TagSection,
} from './ApiSpec';
import { JsonEntry, JsonNode } from './JsonNode';
import { SchemaShape } from './SchemaShape';
import { Slug } from './Slug';

const HTTP_METHODS: readonly string[] = [
    'get',
    'put',
    'post',
    'delete',
    'options',
    'head',
    'patch',
    'trace',
];

/** The section untagged operations land in, so an operation is never unreachable from the nav. */
export const UNTAGGED_SECTION = 'Operations';

/**
 * Reads one OpenAPI 3.0-or-3.1 document into an {@link ApiSpec}.
 *
 * ## Nothing here is SORTED
 *
 * Both orders in the finished site are published decisions somebody made, so neither is re-derived:
 * the reference order is the document's own `tags[]`, and the prose order is `docs.manifest.json`.
 * Alphabetising either is not a cleanup — it reorders partner-facing navigation.
 *
 * A tag that appears on an operation without being declared in `tags[]` still gets its own section,
 * appended in first-seen order. A tag missing from the sidebar is an operation a partner cannot
 * find, which reads exactly like an operation that does not exist.
 *
 * ## Webhooks
 *
 * A top-level `webhooks:` entry files into the SAME section as the operations sharing its tag, and
 * is APPENDED after them, because the events are what happens as a result of the calls above.
 */
export class SpecReader {
    private readonly shape = new SchemaShape();

    read(root: JsonNode): ApiSpec {
        const schemas = this.readSchemas(root);
        const sections = this.readSections(root);
        return new ApiSpec(
            root.at('info').text('title') ?? 'API reference',
            root.at('info').text('version') ?? '',
            root.at('info').text('description') ?? '',
            this.readServers(root),
            sections,
            this.readSecuritySchemes(root),
            schemas,
            this.securityKeysIn(root),
        );
    }

    private readServers(root: JsonNode): readonly ServerInfo[] {
        return root
            .list('servers')
            .map(
                (entry: JsonNode): ServerInfo =>
                    new ServerInfo(entry.text('url') ?? '', entry.text('description')),
            );
    }

    private readSecuritySchemes(root: JsonNode): readonly SecuritySchemeInfo[] {
        const declared = root.at('components').at('securitySchemes');
        return declared
            .entries()
            .map(
                (entry: JsonEntry): SecuritySchemeInfo =>
                    new SecuritySchemeInfo(
                        entry.key,
                        entry.value.text('type') ?? '',
                        entry.value.text('in') ?? '',
                        entry.value.text('name') ?? '',
                        entry.value.text('description'),
                    ),
            );
    }

    private readSchemas(root: JsonNode): readonly NamedSchema[] {
        const slugs = new Slug();
        return root
            .at('components')
            .at('schemas')
            .entries()
            .map(
                (entry: JsonEntry): NamedSchema =>
                    new NamedSchema(
                        entry.key,
                        slugs.unique(entry.key),
                        entry.value,
                        this.shape.hasOwnPage(entry.value),
                    ),
            );
    }

    private readSections(root: JsonNode): readonly TagSection[] {
        const slugs = new Slug();
        const operations = this.readOperations(root, slugs);
        const webhooks = this.readWebhooks(root, slugs);
        const order = this.sectionOrder(root, operations, webhooks);
        const sections: TagSection[] = [];
        for (const tag of order) {
            const inTag = operations.filter((one: OperationInfo): boolean => one.tag === tag);
            const eventsInTag = webhooks.filter((one: OperationInfo): boolean => one.tag === tag);
            sections.push(
                new TagSection(tag, this.tagDescription(root, tag), [...inTag, ...eventsInTag]),
            );
        }
        return sections;
    }

    /** `tags[]` first, in its published order, then any tag only an operation mentions. */
    private sectionOrder(
        root: JsonNode,
        operations: readonly OperationInfo[],
        webhooks: readonly OperationInfo[],
    ): readonly string[] {
        const order: string[] = [];
        for (const declared of root.list('tags')) {
            const name = declared.text('name');
            if (name !== undefined && !order.includes(name)) {
                order.push(name);
            }
        }
        for (const one of [...operations, ...webhooks]) {
            if (!order.includes(one.tag)) {
                order.push(one.tag);
            }
        }
        return order.filter((tag: string): boolean =>
            [...operations, ...webhooks].some((one: OperationInfo): boolean => one.tag === tag),
        );
    }

    private tagDescription(root: JsonNode, tag: string): string {
        for (const declared of root.list('tags')) {
            if (declared.text('name') === tag) {
                return declared.text('description') ?? '';
            }
        }
        return '';
    }

    private readOperations(root: JsonNode, slugs: Slug): readonly OperationInfo[] {
        const found: OperationInfo[] = [];
        for (const pathEntry of root.at('paths').entries()) {
            for (const methodEntry of pathEntry.value.entries()) {
                if (!HTTP_METHODS.includes(methodEntry.key)) {
                    continue;
                }
                found.push(
                    this.readOperation(
                        root,
                        methodEntry.value,
                        slugs,
                        methodEntry.key.toUpperCase(),
                        pathEntry.key,
                        false,
                    ),
                );
            }
        }
        return found;
    }

    private readWebhooks(root: JsonNode, slugs: Slug): readonly OperationInfo[] {
        const found: OperationInfo[] = [];
        for (const eventEntry of root.at('webhooks').entries()) {
            for (const methodEntry of eventEntry.value.entries()) {
                if (!HTTP_METHODS.includes(methodEntry.key)) {
                    continue;
                }
                found.push(
                    this.readOperation(root, methodEntry.value, slugs, '', eventEntry.key, true),
                );
            }
        }
        return found;
    }

    private readOperation(
        root: JsonNode,
        node: JsonNode,
        slugs: Slug,
        httpMethod: string,
        pathOrEvent: string,
        isWebhook: boolean,
    ): OperationInfo {
        const name = node.text('summary') ?? node.text('operationId') ?? pathOrEvent;
        return new OperationInfo(
            name,
            slugs.unique(name),
            httpMethod,
            isWebhook ? '' : pathOrEvent,
            node.text('description') ?? '',
            this.tagOf(node),
            this.requestSchemaOf(node),
            this.responsesOf(node),
            isWebhook,
            isWebhook ? [] : this.operationSecurityKeys(root, node),
            isWebhook ? pathOrEvent : '',
        );
    }

    private tagOf(node: JsonNode): string {
        for (const tag of node.list('tags')) {
            const name = tag.asText();
            if (name !== undefined) {
                return name;
            }
        }
        return UNTAGGED_SECTION;
    }

    private requestSchemaOf(node: JsonNode): JsonNode | undefined {
        const schema = node.at('requestBody').at('content').at('application/json').at('schema');
        return schema.isObject() ? schema : undefined;
    }

    private responsesOf(node: JsonNode): readonly ResponseInfo[] {
        return node
            .at('responses')
            .entries()
            .map((entry: JsonEntry): ResponseInfo => {
                const schema = entry.value.at('content').at('application/json').at('schema');
                return new ResponseInfo(
                    entry.key,
                    entry.value.text('description') ?? '',
                    schema.isObject() ? schema : undefined,
                );
            });
    }

    /**
     * The credentials this operation needs: its own `security` when it states one, the document's
     * otherwise. An operation stating `security: []` needs none, and that empty array is the
     * OpenAPI spelling of "no credential" rather than of "inherit" — so it must not fall back.
     */
    private operationSecurityKeys(root: JsonNode, node: JsonNode): readonly string[] {
        if (Array.isArray(node.at('security').raw)) {
            return this.securityKeysIn(node);
        }
        return this.securityKeysIn(root);
    }

    private securityKeysIn(holder: JsonNode): readonly string[] {
        const keys: string[] = [];
        for (const requirement of holder.list('security')) {
            for (const key of requirement.keys()) {
                if (!keys.includes(key)) {
                    keys.push(key);
                }
            }
        }
        return keys;
    }
}
