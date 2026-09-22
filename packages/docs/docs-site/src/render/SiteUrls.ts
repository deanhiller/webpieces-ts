import { NamedSchema, OperationInfo } from '../spec/ApiSpec';
import { ProsePage } from '../manifest/DocsManifest';

/**
 * Every URL the site has, in ONE place.
 *
 * Each is a real FILE ending in `index.html`, and each is stated RELATIVE to the site root; a page
 * prepends its own `../` prefix with {@link prefixFor}. Root-relative links (`/reference/…`) only
 * work when the site is the whole host, and a generated reference is routinely served under a path —
 * GitHub Pages does it by default — where a root-relative link 404s on every page but the home one.
 * Ending each href in `index.html` rather than a bare directory is the same argument one level down:
 * a directory URL needs a server willing to serve the index, and `file://` is not one.
 */
export class SiteUrls {
    /** The generated home page. */
    home(): string {
        return 'index.html';
    }

    /** `reference/<kebab-operation>/index.html` — one file per operation URL. */
    operation(operation: OperationInfo): string {
        return `reference/${operation.slug}/index.html`;
    }

    /** `schemas/<kebab-name>/index.html` — one file per named object DTO. */
    schema(schema: NamedSchema): string {
        return `schemas/${schema.slug}/index.html`;
    }

    /** `prose/<kebab-title>/index.html`. */
    prose(page: ProsePage): string {
        return `prose/${page.slug}/index.html`;
    }

    /** `../` once per directory between a page and the site root. */
    prefixFor(url: string): string {
        return '../'.repeat(url.split('/').length - 1);
    }
}
