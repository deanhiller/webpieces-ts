import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DocsSiteCli } from '../cli/DocsSiteCli';

/**
 * Render a document webpieces did NOT generate — 3.0's dialect, 3.0's reference shapes, a
 * self-referential DTO, an undefined `$ref` and an untagged operation.
 *
 * This is the test that keeps the decoupling honest. `@webpieces/openapi-generator` emits exactly
 * one of the three reference shapes, so a suite built only on our own goldens would pass forever
 * while the renderer silently dropped the type of every field in every 3.0 document in the world.
 */
const FIXTURES = path.join(__dirname, 'fixtures');
const SPEC = path.join(FIXTURES, 'mixed-dialect-openapi.json');

class Site {
    readonly out = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-docs-site-'));

    render(): void {
        new DocsSiteCli().run(['--spec', SPEC, '--out', this.out], FIXTURES);
    }

    page(...segments: string[]): string {
        return fs.readFileSync(path.join(this.out, ...segments, 'index.html'), 'utf8');
    }

    exists(...segments: string[]): boolean {
        return fs.existsSync(path.join(this.out, ...segments, 'index.html'));
    }
}

const site = new Site();

describe('a conforming document this package did not generate', () => {
    beforeAll((): void => {
        site.render();
    });

    it('reads the 3.0 allOf-of-one-ref wrapper, keeping BOTH the type and the prose beside it', () => {
        const page = site.page('schemas', 'category');
        expect(page).toContain('<span class="field-name">parent</span>');
        expect(page).toContain('>Category</a>');
        expect(page).toContain('The 3.0 wrapper shape');
    });

    it('reads the 3.1 nullable reference, and shows the NON-null type', () => {
        const page = site.page('schemas', 'category');
        expect(page).toContain('<span class="field-name">season</span>');
        expect(page).toContain('<span class="field-type">Season</span>');
        expect(page).toContain('<span class="chip">spring</span>');
    });

    it('renders a format inside angle brackets, and a nullable type without its null', () => {
        const page = site.page('schemas', 'category');
        expect(page).toContain('string&lt;date&gt;');
        expect(page).toContain('string&lt;date-time&gt;');
        expect(page).not.toContain('string | null');
    });

    it('leaves an UNDEFINED $ref inline rather than linking to a page that is not there', () => {
        const page = site.page('schemas', 'category');
        expect(page).toContain('<span class="field-type">NotDefinedAnywhere</span>');
        expect(site.exists('schemas', 'not-defined-anywhere')).toBe(false);
    });

    it('survives a self-referential DTO, because the root is marked seen before its own properties', () => {
        const page = site.page('reference', 'tree-api-plant-tree');
        expect(page).toContain('&quot;parent&quot;: {}');
    });

    it('gives an untagged operation a section of its own rather than dropping it from the nav', () => {
        expect(site.exists('reference', 'tree-api-count-trees')).toBe(true);
        expect(site.page('reference', 'tree-api-count-trees')).toContain('<summary>Operations</summary>');
    });

    it('honours an operation stating security: [] instead of inheriting the document requirement', () => {
        const page = site.page('reference', 'tree-api-count-trees');
        expect(page).not.toContain('x-mixed-key');
        expect(site.page('reference', 'tree-api-plant-tree')).toContain('x-mixed-key');
    });

    it('renders a Headers list on the response card, resolving a $ref into components.headers (#1292)', () => {
        const page = site.page('reference', 'tree-api-plant-tree');
        const card = page.slice(page.indexOf('<h2>Responses</h2>'));
        expect(card).toContain('<div class="headers-head">Headers</div>');
        expect(card).toContain('<span class="field-name">x-request-id</span>');
        expect(card).toContain('Quote it in a support request.');
        expect(card).toContain('<span class="field-name">X-Rate-Remaining</span>');
        expect(card).toContain('<span class="field-type">integer</span>');
        expect(card).toContain('<span class="field-optional">OPTIONAL</span>');
        // BESIDE the body schema, on the same card.
        expect(card.indexOf('x-request-id')).toBeLessThan(card.indexOf('</details>'));
    });

    it('lists in:"header" parameters in the request section — path item and operation, $ref resolved (#1292)', () => {
        const page = site.page('reference', 'tree-api-plant-tree');
        const request = page.slice(page.indexOf('<h2>Request headers</h2>'), page.indexOf('<h2>Request body</h2>'));
        expect(request).toContain('<span class="field-name">X-Trace</span>');
        expect(request).toContain('string&lt;uuid&gt;');
        expect(request).toContain('<span class="field-required">REQUIRED</span>');
        expect(request).toContain('Correlates the call across services.');
        expect(request).toContain('<span class="field-name">X-Tree-Owner</span>');
        expect(page).not.toContain('<span class="field-name">dryRun</span>');
    });

    it('renders no Headers heading for an operation that declares none', () => {
        const page = site.page('reference', 'tree-api-count-trees');
        expect(page).not.toContain('headers-head');
        expect(page).not.toContain('Request headers');
    });

    it('renders the info description as markdown, escaping anything that is not a known mark', () => {
        const home = site.page('.');
        expect(home).toContain('<strong>not</strong>');
    });
});
