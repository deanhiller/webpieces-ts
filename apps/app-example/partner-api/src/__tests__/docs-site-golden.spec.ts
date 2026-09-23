import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DocsSiteCli } from '@webpieces/docs-site';

/**
 * Render the PUBLIC document of this example contract into a docs site, and assert the properties
 * #985 names — against the real partner-facing document rather than a fixture, because the whole
 * claim being tested is that a conforming document renders.
 *
 * ## Why the PUBLIC document and not the private one
 *
 * A docs site is the partner-facing artifact, so it is rendered from the partner-facing document.
 * `full-private-openapi.json` carries hidden endpoints and an internal-use-only line, and a site
 * built from it would publish exactly the operations somebody decided not to publish.
 *
 * ## Why this asserts properties and the OpenAPI golden asserts bytes
 *
 * `openapi-golden.spec.ts` pins its documents byte for byte because a moved byte there IS a moved
 * contract. Pinning the HTML would instead pin the stylesheet, the class names and the markup —
 * none of which a partner has a contract about — and every layout change would arrive as a
 * thousand-line diff nobody could read the real change out of. So the ASSERTIONS are the golden:
 * they name the properties a reader depends on, and they are what a layout change must keep true.
 *
 * The input is the document golden `openapi-golden.spec.ts` proves is what the generator emits
 * today, so this spec renders the real partner-facing document without re-running the generator.
 */
const PROJECT = path.resolve(__dirname, '..', '..');
const SPEC = path.join(__dirname, 'goldens', 'public-openapi.json');
const PROSE = path.join(PROJECT, 'docs');

class Site {
    readonly out = fs.mkdtempSync(path.join(os.tmpdir(), 'partner-docs-site-'));

    render(): void {
        new DocsSiteCli().run(['--spec', SPEC, '--prose', PROSE, '--out', this.out], PROJECT);
    }

    exists(...segments: string[]): boolean {
        return fs.existsSync(path.join(this.out, ...segments));
    }

    page(...segments: string[]): string {
        return fs.readFileSync(path.join(this.out, ...segments, 'index.html'), 'utf8');
    }

    home(): string {
        return fs.readFileSync(path.join(this.out, 'index.html'), 'utf8');
    }
}

const site = new Site();

describe('the docs site rendered from the example contract', () => {
    beforeAll((): void => {
        site.render();
    });

    it('writes one pre-rendered page per operation, including the webhook', () => {
        expect(site.exists('reference', 'fetch-orders', 'index.html')).toBe(true);
        expect(site.exists('reference', 'cancel-order', 'index.html')).toBe(true);
        expect(site.exists('reference', 'order-state-changed', 'index.html')).toBe(true);
    });

    it('writes one page per named OBJECT dto, and none for a named enum', () => {
        expect(site.exists('schemas', 'order', 'index.html')).toBe(true);
        expect(site.exists('schemas', 'fetch-orders-request', 'index.html')).toBe(true);
        expect(site.exists('schemas', 'delivery-window', 'index.html')).toBe(true);
        expect(site.exists('schemas', 'order-state', 'index.html')).toBe(false);
    });

    it('LINKS a reference to a named object rather than inlining its fields', () => {
        const page = site.page('schemas', 'fetch-orders-response');
        expect(page).toContain('../../schemas/order/index.html');
        expect(page).not.toContain('Stable for the life of the order');
    });

    it('resolves the same reference FULLY in the generated example body', () => {
        const page = site.page('reference', 'fetch-orders');
        expect(page).toContain('&quot;storeId&quot;: &quot;storeId&quot;');
    });

    it('renders a oneOf as one labelled variant per branch, all expanded', () => {
        const page = site.page('schemas', 'delivery-window');
        expect(page).toContain('ScheduledWindow');
        expect(page).toContain('AsapWindow');
        expect(page).toContain('kind: "scheduled"');
        expect(page).toContain('kind: "asap"');
    });

    it('gives an enum the COMPLETE Possible values chip line', () => {
        const page = site.page('reference', 'cancel-order');
        expect(page).toContain('Possible values:');
        for (const value of ['placed', 'accepted', 'delivered', 'cancelled']) {
            expect(page).toContain(`<span class="chip">${value}</span>`);
        }
    });

    it('gives a webhook no method, no path and no code samples', () => {
        const page = site.page('reference', 'order-state-changed');
        expect(page).toContain('WEBHOOK');
        expect(page).toContain('order.state-changed');
        expect(page).not.toContain('class="tab"');
        expect(page).not.toContain('https://api.example.com');
    });

    it('builds the code samples FROM THE SPEC — server url, path and security header names', () => {
        const page = site.page('reference', 'fetch-orders');
        expect(page).toContain('https://api.example.com/orders/fetch');
        expect(page).toContain('x-api-key');
        expect(page).toContain('x-organization-id');
        for (const language of ['HTTP', 'JavaScript', 'Go', 'Java']) {
            expect(page).toContain(`data-language="${language.toLowerCase()}"`);
        }
    });

    it('takes the reference order from tags[] and the prose order from docs.manifest.json', () => {
        const home = site.home();
        expect(home.indexOf('Getting started')).toBeLessThan(home.indexOf('Authentication'));
        expect(home.indexOf('Authentication')).toBeLessThan(home.indexOf('Receiving webhooks'));
        expect(home.indexOf('>Orders<')).toBeLessThan(home.indexOf('>Webhooks<'));
    });

    it('files the webhook into the same nav section as the tag it shares', () => {
        const page = site.page('reference', 'order-state-changed');
        const section = page.indexOf('<summary>Webhooks</summary>');
        expect(section).toBeGreaterThan(-1);
        expect(page.indexOf('reference/order-state-changed/index.html')).toBeGreaterThan(section);
    });
});
