import { ApiSpec, NamedSchema, OperationInfo, ServerInfo, TagSection } from '../spec/ApiSpec';
import { CardRenderer } from './CardRenderer';
import { CodeSampleBuilder } from '../samples/CodeSamples';
import { ExampleBuilder } from '../spec/ExampleBuilder';
import { FieldTreeBuilder } from '../spec/FieldTree';
import { FieldTreeRenderer } from './FieldTreeRenderer';
import { Html } from './Html';
import { Layout } from './Layout';
import { Markdown } from '../markdown/Markdown';
import { NavBuilder } from './NavModel';
import { OperationPageRenderer } from './OperationPageRenderer';
import { ProsePage } from '../manifest/DocsManifest';
import { RenderedSite, SiteAsset, SitePage } from './SitePage';
import { SchemaLens } from '../spec/SchemaLens';
import { SiteScript } from '../assets/SiteScript';
import { SiteStyles } from '../assets/SiteStyles';
import { SiteUrls } from './SiteUrls';

/** The nav title of the generated home page. */
export const OVERVIEW_TITLE = 'Overview';

/**
 * Turns one {@link ApiSpec} plus its prose into the complete list of files to write.
 *
 * Every URL is a FILE — `index.html`, `prose/<slug>/index.html`, `reference/<slug>/index.html`,
 * `schemas/<slug>/index.html` — so a deep link resolves without JS, the output is a folder any
 * static host serves, and a JSDoc edit is a diff on the one page it affects.
 *
 * ## One page per named object DTO
 *
 * Only OBJECTS get pages. A named enum or scalar alias renders inline at each use site with its
 * chips, because a page holding one line of values costs a reader the context they were reading.
 * An UNDEFINED `$ref` also stays inline — a link to a page the document never defined is a dead
 * link, which is strictly worse than the unresolved type name it replaced.
 */
export class SiteRenderer {
    private readonly markdown = new Markdown();
    private readonly cards = new CardRenderer();
    private readonly html = new Html();
    private readonly urls = new SiteUrls();

    /** @param spec the document. @param prose the manifest's pages, in the manifest's order. */
    render(spec: ApiSpec, prose: readonly ProsePage[], titleOverride: string): RenderedSite {
        const lens = new SchemaLens(spec);
        const fields = new FieldTreeBuilder(lens);
        const trees = new FieldTreeRenderer(this.markdown, this.urls);
        const examples = new ExampleBuilder(lens);
        const title = titleOverride === '' ? spec.title : titleOverride;
        const nav = new NavBuilder(this.urls).build(spec, prose, OVERVIEW_TITLE);
        const layout = new Layout(nav, this.urls, title, spec.version);
        const operations = new OperationPageRenderer(
            spec,
            fields,
            trees,
            this.markdown,
            this.cards,
            new CodeSampleBuilder(spec, examples),
            examples,
            layout,
            this.urls,
        );
        const pages: SitePage[] = [this.overview(spec, layout)];
        for (const page of prose) {
            pages.push(this.prosePage(page, layout));
        }
        for (const operation of spec.operations()) {
            pages.push(operations.page(operation));
        }
        for (const schema of spec.schemas) {
            if (schema.hasOwnPage) {
                pages.push(this.schemaPage(schema, fields, trees, examples, layout));
            }
        }
        return new RenderedSite(pages, this.assets());
    }

    /** The stylesheet and the script, written beside the pages. */
    assets(): readonly SiteAsset[] {
        return [
            new SiteAsset('styles.css', SiteStyles.CSS),
            new SiteAsset('site.js', SiteScript.JS),
        ];
    }

    private overview(spec: ApiSpec, layout: Layout): SitePage {
        const parts = [`<h1>${this.html.escape(spec.title)}</h1>`];
        if (spec.description !== '') {
            parts.push(this.markdown.render(spec.description));
        }
        parts.push(this.sectionIndex(spec));
        const url = this.urls.home();
        return new SitePage(
            url,
            OVERVIEW_TITLE,
            layout.render(url, OVERVIEW_TITLE, parts.join('\n'), this.serversCard(spec)),
        );
    }

    private sectionIndex(spec: ApiSpec): string {
        return spec.sections
            .map((section: TagSection): string => {
                const items = section.operations
                    .map(
                        (operation: OperationInfo): string =>
                            `<li>${this.html.link(this.urls.operation(operation), operation.name)}</li>`,
                    )
                    .join('');
                return `<h2>${this.html.escape(section.name)}</h2>${this.markdown.render(section.description)}<ul>${items}</ul>`;
            })
            .join('\n');
    }

    private serversCard(spec: ApiSpec): string {
        if (spec.servers.length === 0) {
            return '';
        }
        const rows = spec.servers
            .map(
                (server: ServerInfo): string =>
                    `<div class="field"><div class="field-head"><span class="field-name">${this.html.escape(server.url)}</span></div><div class="field-doc">${this.html.escape(server.description ?? '')}</div></div>`,
            )
            .join('');
        return this.cards.panel('SERVERS', rows);
    }

    private prosePage(page: ProsePage, layout: Layout): SitePage {
        const url = this.urls.prose(page);
        const body = `<h1>${this.html.escape(page.title)}</h1>${this.markdown.render(page.markdown)}`;
        return new SitePage(url, page.title, layout.render(url, page.title, body, ''));
    }

    private schemaPage(
        schema: NamedSchema,
        fields: FieldTreeBuilder,
        trees: FieldTreeRenderer,
        examples: ExampleBuilder,
        layout: Layout,
    ): SitePage {
        const url = this.urls.schema(schema);
        const prefix = this.urls.prefixFor(url);
        const parts = [`<h1>${this.html.escape(schema.name)}</h1>`];
        const description = schema.node.text('description');
        if (description !== undefined) {
            parts.push(this.markdown.render(description));
        }
        const variants = fields.variantsOf(schema.node);
        parts.push(
            variants.length > 0
                ? trees.renderVariants(
                      variants,
                      fields.discriminatorPropertyOf(schema.node),
                      prefix,
                  )
                : trees.render(fields.fieldsOf(schema.node), prefix),
        );
        const sample = examples.render(examples.build(schema.node));
        return new SitePage(
            url,
            schema.name,
            layout.render(
                url,
                schema.name,
                parts.join('\n'),
                this.cards.example('EXAMPLE', sample),
            ),
        );
    }
}
