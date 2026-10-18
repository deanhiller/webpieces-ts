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
        expect(site.exists('reference', 'partner-orders-api-fetch-orders', 'index.html')).toBe(true);
        expect(site.exists('reference', 'partner-orders-api-cancel-order', 'index.html')).toBe(true);
        expect(site.exists('reference', 'partner-delivery-webhook-api-order-state-changed', 'index.html')).toBe(true);
    });

    it('writes one page per named OBJECT dto, and none for a named enum', () => {
        expect(site.exists('schemas', 'order', 'index.html')).toBe(true);
        expect(site.exists('schemas', 'delivery-window', 'index.html')).toBe(true);
        expect(site.exists('schemas', 'order-state', 'index.html')).toBe(false);
    });

    it('writes NO page for a single-use request/response wrapper, which is inline at its operation (#1303)', () => {
        for (const wrapper of ['fetch-orders-request', 'fetch-orders-response', 'cancel-order-request']) {
            expect(site.exists('schemas', wrapper, 'index.html'), wrapper).toBe(false);
        }
        // ...and nothing links to one.
        for (const page of [site.home(), site.page('reference', 'partner-orders-api-fetch-orders')]) {
            expect(page).not.toContain('schemas/fetch-orders-request/');
            expect(page).not.toContain('schemas/fetch-orders-response/');
        }
    });

    it('heads an INLINE body with its title and description, then its fields (#1303)', () => {
        const page = site.page('reference', 'partner-orders-api-fetch-orders');
        const request = page.slice(page.indexOf('<h2>Request body</h2>'), page.indexOf('<h2>Responses</h2>'));
        expect(request).toContain('<code title="schema title">FetchOrdersRequest</code>');
        expect(request).toContain('Which orders to fetch: one store');
        expect(request).toContain('<span class="field-name">storeId</span>');
        const responses = page.slice(page.indexOf('<h2>Responses</h2>'));
        expect(responses).toContain('<code title="schema title">FetchOrdersResponse</code>');
        expect(responses).toContain('One page of a store');
    });

    it('LINKS a reference to a named object rather than inlining its fields', () => {
        const page = site.page('reference', 'partner-orders-api-fetch-orders');
        expect(page).toContain('../../schemas/order/index.html');
        expect(page).not.toContain('Stable for the life of the order');
    });

    it('resolves the same reference FULLY in the generated example body', () => {
        const page = site.page('reference', 'partner-orders-api-fetch-orders');
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
        const page = site.page('reference', 'partner-orders-api-cancel-order');
        expect(page).toContain('Possible values:');
        for (const value of ['placed', 'accepted', 'delivered', 'cancelled']) {
            expect(page).toContain(`<span class="chip">${value}</span>`);
        }
    });

    it('gives a webhook no method, no path and no code samples', () => {
        const page = site.page('reference', 'partner-delivery-webhook-api-order-state-changed');
        expect(page).toContain('WEBHOOK');
        expect(page).toContain('order.state-changed');
        expect(page).not.toContain('class="tab"');
        expect(page).not.toContain('https://api.example.com');
    });

    it('shows the retry sentence on a route and never on a webhook (#1302)', () => {
        // We send a webhook and retry its delivery ourselves; "NOT safe to retry" there is backwards.
        const webhook = site.page('reference', 'partner-delivery-webhook-api-order-state-changed');
        expect(webhook).not.toMatch(/safe to retry/i);
        expect(site.page('reference', 'partner-orders-api-fetch-orders')).toContain('Safe to retry');
    });

    it('builds the code samples FROM THE SPEC — server url, path and security header names', () => {
        const page = site.page('reference', 'partner-orders-api-fetch-orders');
        expect(page).toContain('https://api.example.com/orders/fetch');
        expect(page).toContain('x-api-key');
        expect(page).toContain('x-organization-id');
        for (const language of ['HTTP', 'JavaScript', 'Go', 'Java']) {
            expect(page).toContain(`data-language="${language.toLowerCase()}"`);
        }
    });

    it('shows the x-request-id response header and the @returns description on every response card (#1292)', () => {
        const page = site.page('reference', 'partner-orders-api-fetch-orders');
        const responses = page.slice(page.indexOf('<h2>Responses</h2>'));
        expect(responses).toContain(
            '200 — The page of matching orders, newest first, with <code>nextFrom</code> set while more remain.',
        );
        const cards = responses.split('<details').length - 1;
        const headed = responses.split('<span class="field-name">x-request-id</span>').length - 1;
        expect(cards).toBeGreaterThan(1);
        expect(headed).toBe(cards);
        expect(responses).toContain('Correlates this response with our logs.');
    });

    it('LINKS a {@link} — published as a code span of the published name — to its page (#1284)', () => {
        const page = site.page('reference', 'partner-orders-api-cancel-order');
        expect(page).toContain(
            '<a href="../../schemas/order/index.html"><code>Order.id</code></a>',
        );
        expect(page).toContain(
            '<a href="../../reference/partner-orders-api-fetch-orders/index.html"><code>PartnerOrdersApi_fetchOrders</code></a>',
        );
        // A single-use wrapper is INLINED at its operation (#1303) and has no page, so a link to it
        // publishes its title as code and the site does NOT link it to a page that does not exist.
        expect(page).toContain('for a <code>FetchOrdersRequest</code> —');
        expect(site.exists('schemas', 'fetch-orders-request')).toBe(false);
    });

    it('keeps a field linked BARE as plain code — neither its class nor a link to a page (#1308)', () => {
        const page = site.page('reference', 'partner-orders-api-fetch-orders');
        // `storeId` is inherited from StoreScopedRequest two levels up; `from` is a sibling.
        expect(page).toContain(
            'Only these states, inside the window <code>from</code> starts, at the store in <code>storeId</code>.',
        );
        expect(page).not.toContain('<code>storeId</code></a>');
        expect(page).not.toContain('<code>from</code></a>');
    });

    it('takes the reference order from tags[] and the prose order from docs.manifest.json', () => {
        const home = site.home();
        expect(home.indexOf('Getting started')).toBeLessThan(home.indexOf('Authentication'));
        expect(home.indexOf('Authentication')).toBeLessThan(home.indexOf('Receiving webhooks'));
        expect(home.indexOf('>Orders<')).toBeLessThan(home.indexOf('>Webhooks<'));
    });

    it('heads each operation page and labels its sidebar link with the @summary, keeping the operationId visible (#1296)', () => {
        const page = site.page('reference', 'partner-orders-api-fetch-orders');
        expect(page).toContain('<h1>Fetch your orders</h1>');
        expect(page).toContain('<code class="op-id" title="operationId">PartnerOrdersApi_fetchOrders</code>');
        expect(page).toContain('<span>Fetch your orders</span>');
        expect(page).toContain('<span>Cancel an order</span>');
        expect(page).toContain('<span>Order state changed</span>');
        expect(page).not.toContain('<span>fetchOrders</span>');
        const webhook = site.page('reference', 'partner-delivery-webhook-api-order-state-changed');
        expect(webhook).toContain('<h1>Order state changed</h1>');
        expect(webhook).toContain('PartnerDeliveryWebhookApi_orderStateChanged');
    });

    it("shows the manifest's summary (info.summary) under the API title on the overview (#1296)", () => {
        const home = site.home();
        const title = home.indexOf('<h1>Example Orders API</h1>');
        expect(title).toBeGreaterThan(-1);
        expect(home.indexOf('<p class="api-summary">Read and cancel the orders placed at your stores')).toBeGreaterThan(title);
    });

    it('files the webhook into the same nav section as the tag it shares', () => {
        const page = site.page('reference', 'partner-delivery-webhook-api-order-state-changed');
        const section = page.indexOf('<summary>Webhooks</summary>');
        expect(section).toBeGreaterThan(-1);
        expect(page.indexOf('reference/partner-delivery-webhook-api-order-state-changed/index.html')).toBeGreaterThan(section);
    });
});
