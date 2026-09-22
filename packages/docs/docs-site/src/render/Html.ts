/**
 * HTML escaping, in ONE place.
 *
 * Every string that reaches the page comes from a document or a markdown file this run read, and
 * both are text. So there is exactly one rule and no exceptions to remember: a value is escaped on
 * its way into the page, and the only thing that is not escaped is markup this package itself wrote.
 * Two escaping helpers would be two rules, and the second one is where an unescaped `<` gets in.
 */
export class Html {
    /** Text into an element body or a double-quoted attribute. */
    escape(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /** One `<a>` to an in-site page. `href` is written by this package, never by a document. */
    link(href: string, text: string): string {
        return `<a href="${href}">${this.escape(text)}</a>`;
    }
}
