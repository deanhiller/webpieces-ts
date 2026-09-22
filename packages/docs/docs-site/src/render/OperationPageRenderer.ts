import { ApiSpec, OperationInfo, ResponseInfo } from '../spec/ApiSpec';
import { CardRenderer } from './CardRenderer';
import { CodeSampleBuilder } from '../samples/CodeSamples';
import { ExampleBuilder } from '../spec/ExampleBuilder';
import { FieldTreeBuilder } from '../spec/FieldTree';
import { FieldTreeRenderer } from './FieldTreeRenderer';
import { Html } from './Html';
import { JsonNode } from '../spec/JsonNode';
import { Layout } from './Layout';
import { Markdown } from '../markdown/Markdown';
import { SiteUrls } from './SiteUrls';
import { SitePage } from './SitePage';

/** The badge a webhook carries everywhere it appears. */
export const WEBHOOK_BADGE = 'WEBHOOK';

/**
 * One pre-rendered page per operation, at `reference/<kebab-operation>/index.html`.
 *
 * ## What a WEBHOOK page leaves out, and why
 *
 * No method, no path, no code samples. The url is the PARTNER's — they host the endpoint wherever
 * they choose — so a `POST https://api.example.com/...` sample on a webhook page invites them to
 * call something that does not exist. What it keeps is the payload, because the payload is the part
 * that IS ours, and the event name, because that is what they match on the wire.
 */
export class OperationPageRenderer {
    private readonly html = new Html();

    constructor(
        private readonly spec: ApiSpec,
        private readonly fields: FieldTreeBuilder,
        private readonly trees: FieldTreeRenderer,
        private readonly markdown: Markdown,
        private readonly cards: CardRenderer,
        private readonly samples: CodeSampleBuilder,
        private readonly examples: ExampleBuilder,
        private readonly layout: Layout,
        private readonly urls: SiteUrls,
    ) {}

    page(operation: OperationInfo): SitePage {
        const url = this.urls.operation(operation);
        const prefix = this.urls.prefixFor(url);
        return new SitePage(
            url,
            operation.name,
            this.layout.render(
                url,
                operation.name,
                this.body(operation, prefix),
                this.cardColumn(operation),
            ),
        );
    }

    private body(operation: OperationInfo, prefix: string): string {
        const parts = [this.head(operation), `<h1>${this.html.escape(operation.name)}</h1>`];
        if (operation.description !== '') {
            parts.push(this.markdown.render(operation.description));
        }
        parts.push(this.requestSection(operation, prefix));
        parts.push(this.responseSection(operation, prefix));
        return parts.join('\n');
    }

    private head(operation: OperationInfo): string {
        if (operation.isWebhook) {
            return `<div class="op-head"><span class="badge">${WEBHOOK_BADGE}</span><code class="op-path">${this.html.escape(operation.eventName)}</code></div>`;
        }
        return `<div class="op-head"><span class="badge">${this.html.escape(operation.httpMethod)}</span><code class="op-path">${this.html.escape(operation.path)}</code></div>`;
    }

    private requestSection(operation: OperationInfo, prefix: string): string {
        if (operation.requestSchema === undefined) {
            return '';
        }
        return `<h2>Request body</h2>${this.tree(operation.requestSchema, prefix)}`;
    }

    private responseSection(operation: OperationInfo, prefix: string): string {
        if (operation.responses.length === 0) {
            return '';
        }
        const blocks = operation.responses
            .map((response: ResponseInfo): string => this.response(response, prefix))
            .join('');
        return `<h2>Responses</h2>${blocks}`;
    }

    private response(response: ResponseInfo, prefix: string): string {
        const summary = `${this.html.escape(response.status)} — ${this.html.escape(response.description)}`;
        const body =
            response.schema === undefined
                ? '<p class="field-doc">No body.</p>'
                : this.tree(response.schema, prefix);
        return `<details class="disclosure" open><summary>${summary}</summary>${body}</details>`;
    }

    /** A `oneOf` renders as expanded variants; anything else renders as one flat field tree. */
    private tree(schema: JsonNode, prefix: string): string {
        const variants = this.fields.variantsOf(schema);
        if (variants.length > 0) {
            return this.trees.renderVariants(
                variants,
                this.fields.discriminatorPropertyOf(schema),
                prefix,
            );
        }
        return this.trees.render(this.fields.fieldsOf(schema), prefix);
    }

    private cardColumn(operation: OperationInfo): string {
        const payload = this.examples.render(this.examples.build(operation.requestSchema));
        if (operation.isWebhook) {
            return this.cards.example('EVENT PAYLOAD', payload);
        }
        return [
            this.cards.authorization(operation, this.spec.securitySchemes),
            this.cards.samples(this.samples.samplesFor(operation)),
        ].join('\n');
    }
}
