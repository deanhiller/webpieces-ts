import { describe, it, expect } from 'vitest';
import { Markdown } from '../markdown/Markdown';

/**
 * The documented subset, and the one safety property: ESCAPE FIRST, then mark. Every case below that
 * mixes markup with markdown is asserting that ordering — mark-then-escape would escape the tags the
 * renderer had just written, and any other ordering can produce a tag the source did not ask for.
 */
const markdown = new Markdown();

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
