import * as ts from 'typescript';
import { StackedJsDoc } from '../model/ApiDocModel';
import { DocLinkReader } from './DocLinkReader';
import { SourceLocation } from './SourceLocation';

/**
 * A node the compiler has attached JSDoc blocks to. `jsDoc` is internal to the TypeScript API and is
 * therefore not on `ts.Node`, so it is named HERE, once, instead of being cast at the use site.
 */
type JsDocCarrier = ts.Node & { jsDoc?: ts.JSDoc[] };

/**
 * TSDoc's spelling of the success-response tag. JSDoc's older `@return` is deliberately NOT read: one
 * spelling per fact, and a refusal naming `@returns` is how an author finds out.
 */
const RETURNS_TAG = 'returns';

/**
 * The standard JSDoc tag for an endpoint's one-line short title (#1296), published as OpenAPI
 * `summary` and MCP `title` / `annotations.title`.
 */
const SUMMARY_TAG = 'summary';

/**
 * The field-level visibility tag (#1246): the field is withheld from the CUSTOMER document. Read by
 * PRESENCE — a bare `@hidden` hides exactly like one with a reason — and its text is never published.
 */
const HIDDEN_TAG = 'hidden';

/**
 * The PROSE half of the model: the JSDoc body, the `@summary` tag, the `@returns` tag, the `@format`
 * tag, the `@mcp` override and the field-level `@hidden` flag (#1246).
 *
 * ## Every `/** *\/` is published — except `@privateRemarks` (#1292)
 *
 * The body and the tags named here are the ONLY text read out of a block. Every other block tag
 * is dropped together with its text, and `@privateRemarks` — TSDoc's standard "inside the doc block,
 * never published" tag — is the one an author writes ON PURPOSE to keep a note out of every document:
 * OpenAPI, MCP tool catalogs, tag and schema descriptions. It is dropped HERE, at extraction, so no
 * renderer can ever reach it — the same reason `{@link}` is read here (below). `@hidden`'s text (#1246)
 * is read, but only into its own field: it is the author's reason for withholding a field, and like
 * `@privateRemarks` it is published nowhere. `//` and `/* *\/`
 * comments are private by construction: the compiler attaches no JSDoc for them.
 *
 * `{@link Foo.bar}` is RESOLVED here, by the compiler, into a `DocLink` encoded in the prose (#1284):
 * what it points at — a type and its model key, a contract operation, or nothing publishable. It is
 * not flattened to its source text, because the source name is exactly what must not be published:
 * a renderer names it as it publishes — the stripped schema name, the operationId, an MCP tool's
 * name — as a markdown code span, through the one grammar `DocLinkText` owns. Nothing downstream
 * parses the inline tag grammar.
 */
export class JsDoc {
    private constructor(
        /**
         * The body text, links encoded (see the class doc), trimmed. Empty string when undocumented.
         * A block TAG is never part of it — `@summary`, `@returns` and the rest are read into their
         * own fields (or dropped), so the short title never repeats inside the description it heads.
         */
        readonly description: string,
        /**
         * The `@summary` block tag's text — the endpoint's one-line short title (#1296), published as
         * the OpenAPI operation `summary` and as MCP `Tool.title` AND `annotations.title`. Undefined
         * when the author wrote none (or wrote the tag with no text); the OpenAPI generator refuses
         * that for every published operation. Kept VERBATIM (trimmed): a second line is the author's
         * mistake to be told about, not something to silently join or cut.
         */
        readonly summary: string | undefined,
        /**
         * The `@returns` block tag's text — what a method's success response carries, published as
         * that response's `description` (#1292). Undefined when the author wrote none (or wrote the
         * tag with no text), which an OpenAPI renderer refuses for an operation with a body.
         */
        readonly returns: string | undefined,
        /** The `@format` block tag's text, e.g. `email` / `date-time`. */
        readonly format: string | undefined,
        /**
         * The `@mcp` block tag's text — the OPTIONAL agent-facing override. Undefined means the
         * author wrote none, which a renderer answers by falling back to {@link description}. The
         * fallback is NOT applied here: "the author wrote an agent-facing sentence" and "we reused
         * the human one" are different facts, and only the first is worth trusting.
         */
        readonly mcp: string | undefined,
        /**
         * The `@mcpHeader <token>` block tag — the MCP 2026 SEP-2243 header a PRIMITIVE tool
         * parameter is mirrored into (`Mcp-Param-{token}`).
         *
         * It is a JSDoc tag and not a decorator because it is a DOCUMENTATION fact about one field
         * of one wire document, and this epic's rule is that documentation has one source. It is the
         * ONLY spelling: the equivalence gate (#983) proved the deleted decorator argument said the
         * same thing, and #984 deleted it.
         */
        readonly mcpHeader: string | undefined,
        /**
         * True when the block carries the `@hidden` tag (#1246). Only a FIELD's is read into the
         * model (`DocumentedField.hidden`); the tag and its text are, like every other tag, never part
         * of {@link description}, so the reason an author gives cannot leak into a published document.
         */
        readonly hidden: boolean,
        /** The `@hidden` tag's text, trimmed; undefined when the tag has none or is absent. */
        readonly hiddenReason: string | undefined,
    ) {}

    /** Read the JSDoc attached to one declaration, resolving every `{@link}` with `links`. */
    // webpieces-disable no-function-outside-class -- static factory; JsDoc has a private constructor so a caller cannot invent prose
    static read(node: ts.Node, links: DocLinkReader): JsDoc {
        const symbolLike = node as JsDocCarrier;
        const blocks = symbolLike.jsDoc ?? [];
        const bodies: string[] = [];
        let summary: string | undefined;
        let returns: string | undefined;
        let format: string | undefined;
        let mcp: string | undefined;
        let mcpHeader: string | undefined;
        let hidden = false;
        let hiddenReason: string | undefined;

        for (const block of blocks) {
            bodies.push(JsDoc.flatten(block.comment, links));
            for (const tag of block.tags ?? []) {
                const name = tag.tagName.text;
                const text = JsDoc.flatten(tag.comment, links);
                // `@privateRemarks` (and every tag not named below) is skipped with its text — see
                // the class doc: it is never published anywhere.
                if (name === SUMMARY_TAG && text !== '') {
                    summary = text;
                } else if (name === RETURNS_TAG && text !== '') {
                    returns = text;
                } else if (name === 'format' && text !== '') {
                    format = text;
                } else if (name === 'mcp' && text !== '') {
                    mcp = text;
                } else if (name === 'mcpHeader' && text !== '') {
                    mcpHeader = text;
                } else if (name === HIDDEN_TAG) {
                    hidden = true;
                    hiddenReason = text === '' ? hiddenReason : text;
                }
            }
        }

        return new JsDoc(
            bodies.join('\n').trim(),
            summary,
            returns,
            format,
            mcp,
            mcpHeader,
            hidden,
            hiddenReason,
        );
    }

    /**
     * The {@link StackedJsDoc} record for `node` when it carries TWO OR MORE JSDoc blocks, else
     * undefined (#1286).
     *
     * A declaration under `node_modules` is never recorded: it is a published package's to own, its
     * author cannot be handed the cure from here, and that package's own generation is what refuses it
     * — the same line the wire closure draws.
     */
    // webpieces-disable no-function-outside-class -- static reader beside read(); both interpret the same jsDoc array
    static stackedAt(node: ts.Node): StackedJsDoc | undefined {
        const blocks = (node as JsDocCarrier).jsDoc ?? [];
        if (blocks.length < 2) {
            return undefined;
        }
        const file = node.getSourceFile();
        if (file.fileName.includes('/node_modules/')) {
            return undefined;
        }
        const blockLines = blocks.map(
            (block: ts.JSDoc) => file.getLineAndCharacterOfPosition(block.getStart(file)).line + 1,
        );
        return new StackedJsDoc(JsDoc.nameOf(node), SourceLocation.of(node), blockLines);
    }

    /** `Widget`, `Widget.name`, `save` — what an author searches the file for. */
    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static nameOf(node: ts.Node): string {
        const name = (node as ts.NamedDeclaration).name;
        const own = name !== undefined ? name.getText() : ts.SyntaxKind[node.kind];
        const parent = node.parent as ts.NamedDeclaration | undefined;
        const isMember =
            parent !== undefined && (ts.isClassLike(parent) || ts.isInterfaceDeclaration(parent));
        return isMember && parent.name !== undefined ? `${parent.name.getText()}.${own}` : own;
    }

    /**
     * A comment's text with every inline link replaced by what {@link DocLinkReader} makes of it.
     *
     * TypeScript hands a commented node either a plain string or an array of parts, and the link
     * parts are the ones with structure. Both shapes are handled here so no caller has to.
     */
    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static flatten(
        comment: string | ts.NodeArray<ts.JSDocComment> | undefined,
        links: DocLinkReader,
    ): string {
        if (comment === undefined) {
            return '';
        }
        if (typeof comment === 'string') {
            return comment.trim();
        }
        const parts: string[] = [];
        for (const part of comment) {
            if (ts.isJSDocLink(part) || ts.isJSDocLinkCode(part) || ts.isJSDocLinkPlain(part)) {
                parts.push(links.textOf(part));
            } else {
                parts.push(part.text);
            }
        }
        return parts.join('').trim();
    }
}
