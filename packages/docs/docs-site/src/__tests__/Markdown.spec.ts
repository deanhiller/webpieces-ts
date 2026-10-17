import { describe, it, expect } from 'vitest';
import { CodeLinks } from '../markdown/CodeLinks';
import { Markdown } from '../markdown/Markdown';

/**
 * The documented subset, and the one safety property: ESCAPE FIRST, then mark. Every case below that
 * mixes markup with markdown is asserting that ordering — mark-then-escape would escape the tags the
 * renderer had just written, and any other ordering can produce a tag the source did not ask for.
 */
const markdown = new Markdown(new CodeLinks(new Map(), new Map()), '');

describe('the markdown subset', () => {
    it('escapes HTML before any inline pattern runs', () => {
        expect(markdown.render('a <script>alert(1)</script> b')).toContain('&lt;script&gt;');
        expect(markdown.render('a <script>alert(1)</script> b')).not.toContain('<script>');
    });

    it('renders headings, paragraphs and rules', () => {
        expect(markdown.render('# Title')).toBe('<h1>Title</h1>');
        expect(markdown.render('### Third')).toBe('<h3>Third</h3>');
        expect(markdown.render('just words')).toBe('<p>just words</p>');
        expect(markdown.render('---')).toBe('<hr />');
    });

    it('renders inline code, bold, italic and links', () => {
        expect(markdown.inline('`x`')).toBe('<code>x</code>');
        expect(markdown.inline('**loud**')).toBe('<strong>loud</strong>');
        expect(markdown.inline('*soft*')).toBe('<em>soft</em>');
        expect(markdown.inline('[here](https://example.com)')).toBe(
            '<a href="https://example.com">here</a>',
        );
    });

    it('renders a fenced code block, with its language and its content escaped', () => {
        const html = markdown.render('```json\n{"a": "<b>"}\n```');
        expect(html).toContain('<pre><code class="language-json">');
        expect(html).toContain('&lt;b&gt;');
    });

    it('renders a table', () => {
        const html = markdown.render('| a | b |\n|---|---|\n| 1 | 2 |');
        expect(html).toContain('<th>a</th>');
        expect(html).toContain('<td>2</td>');
    });

    it('renders bullet and numbered lists, and a blockquote', () => {
        expect(markdown.render('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
        expect(markdown.render('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
        expect(markdown.render('> quoted')).toBe('<blockquote><p>quoted</p></blockquote>');
    });

    it('does not let a paragraph swallow the block that follows it', () => {
        const html = markdown.render('words\n# Heading');
        expect(html).toContain('<p>words</p>');
        expect(html).toContain('<h1>Heading</h1>');
    });
});

describe('a code span naming an operation or a schema (#1284)', () => {
    const links = new CodeLinks(
        new Map([
            ['fetchOrders', 'reference/fetch-orders/index.html'],
            ['Both', 'reference/both/index.html'],
        ]),
        new Map([
            ['Order', 'schemas/order/index.html'],
            ['Both', 'schemas/both/index.html'],
        ]),
    );
    const page = new Markdown(links, '').forPage('../../');

    it("links an operationId to the operation's page, relative to the page it is on", () => {
        expect(page.inline('Call `fetchOrders` first.')).toBe(
            'Call <a href="../../reference/fetch-orders/index.html"><code>fetchOrders</code></a> first.',
        );
    });

    it("links a schema, and a member of one, to the schema's page", () => {
        expect(page.inline('`Order`')).toBe(
            '<a href="../../schemas/order/index.html"><code>Order</code></a>',
        );
        expect(page.inline('`Order.id`')).toBe(
            '<a href="../../schemas/order/index.html"><code>Order.id</code></a>',
        );
    });

    it('leaves an unknown, or an ambiguous, code span plain code', () => {
        expect(page.inline('`somethingElse`')).toBe('<code>somethingElse</code>');
        expect(page.inline('`Both`')).toBe('<code>Both</code>');
        expect(page.inline('`fetchOrders.x`')).toBe('<code>fetchOrders.x</code>');
    });

    it('never links inside a fenced code block', () => {
        expect(page.render('```\nfetchOrders\n```')).not.toContain('<a ');
    });
});
