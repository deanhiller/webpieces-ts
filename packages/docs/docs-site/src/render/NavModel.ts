import { ApiSpec, NamedSchema, OperationInfo, TagSection } from '../spec/ApiSpec';
import { ProsePage } from '../manifest/DocsManifest';
import { SiteUrls } from './SiteUrls';

/** The nav group the prose pages sit in, above the reference. */
export const GUIDES_GROUP = 'Guides';

/** The nav group every named object DTO gets a page under. */
export const SCHEMAS_GROUP = 'Schemas';

/** One line in the nav tree. `badge` is drawn beside the title — `WEBHOOK`, or an HTTP method. */
export class NavLink {
    constructor(
        readonly title: string,
        /** Relative to the site ROOT; each page prepends its own `../` prefix. */
        readonly url: string,
        readonly badge: string,
    ) {}
}

/** One collapsible section of the nav tree. */
export class NavGroup {
    constructor(
        readonly title: string,
        readonly links: readonly NavLink[],
    ) {}
}

/** The nav tree, as data. {@link NavBuilder} is what puts it in this order. */
export class NavModel {
    constructor(readonly groups: readonly NavGroup[]) {}
}

/**
 * Builds the nav tree: prose first, then ONE SECTION PER OPENAPI TAG in the document's own `tags[]`
 * order, then the schema pages.
 *
 * **Every tag is its own section.** A tag missing from the sidebar is an operation a partner cannot
 * find, which reads exactly like an operation that does not exist — so the sections come from the
 * tags rather than from a hand-maintained list a new tag would have to be added to.
 *
 * Webhooks appear inside the section of the tag they share, appended after that tag's operations and
 * badged, because the events are the consequence of the calls above them.
 */
export class NavBuilder {
    constructor(private readonly urls: SiteUrls) {}

    build(spec: ApiSpec, prose: readonly ProsePage[], overviewTitle: string): NavModel {
        const groups: NavGroup[] = [
            new NavGroup(GUIDES_GROUP, this.guideLinks(prose, overviewTitle)),
        ];
        for (const section of spec.sections) {
            groups.push(new NavGroup(section.name, this.referenceLinks(section)));
        }
        const schemaLinks = this.schemaLinks(spec);
        if (schemaLinks.length > 0) {
            groups.push(new NavGroup(SCHEMAS_GROUP, schemaLinks));
        }
        return new NavModel(groups);
    }

    private guideLinks(prose: readonly ProsePage[], overviewTitle: string): readonly NavLink[] {
        const links = [new NavLink(overviewTitle, this.urls.home(), '')];
        for (const page of prose) {
            links.push(new NavLink(page.title, this.urls.prose(page), ''));
        }
        return links;
    }

    private referenceLinks(section: TagSection): readonly NavLink[] {
        return section.operations.map(
            (operation: OperationInfo): NavLink =>
                new NavLink(
                    operation.name,
                    this.urls.operation(operation),
                    operation.isWebhook ? 'WEBHOOK' : operation.httpMethod,
                ),
        );
    }

    private schemaLinks(spec: ApiSpec): readonly NavLink[] {
        return spec.schemas
            .filter((schema: NamedSchema): boolean => schema.hasOwnPage)
            .map(
                (schema: NamedSchema): NavLink =>
                    new NavLink(schema.name, this.urls.schema(schema), ''),
            );
    }
}
