/**
 * What a JSDoc `{@link X}` names, as the COMPILER resolved it at extraction (#1284).
 *
 * A link is a reference, and a reference is published under the target's PUBLISHED identity — never
 * its source name. `{@link MenuDto}` must publish the schema name `Menu` when `schemaNames` strips
 * `Dto`, and `{@link OrdersApi.fetchOrders}` must publish the operation, not leak the contract class
 * name to a partner. Neither name is known where the JSDoc is read: the schema name of a type in a
 * bundled document depends on what else that document reaches, the operationId on the manifest's
 * `operationIds` style, and an MCP catalog names a tool by its `@WpMcpTool` name. So extraction
 * records WHAT the link points at, as one of these, and each renderer names it — see
 * {@link DocLinkText}.
 */
export enum DocLinkKind {
    /** A named type — class, interface, enum or alias — optionally with a `.member` tail. */
    TYPE = 'type',
    /** A method of an `@ApiPath` contract: a published operation. */
    OPERATION = 'operation',
    /** A target that names nothing any document publishes. Always refused by a renderer. */
    UNRESOLVED = 'unresolved',
}

/** One resolved `{@link}`. Data only: a renderer reads it through {@link DocLinkText}. */
export class DocLink {
    constructor(
        readonly kind: DocLinkKind,
        /** The target exactly as written — `MenuDto.items`, `OrdersApi.fetchOrders`. */
        readonly written: string,
        /** `{@link X | the label}` / `{@link X the label}`'s label; undefined when there is none. */
        readonly label: string | undefined,
        /** Pointer-style `path/to/File.ts:12:5` of the link itself, for a refusal that names it. */
        readonly location: string,
        /**
         * {@link DocLinkKind.TYPE}: the {@link ApiDocModel.types} key of the type, and its
         * schemaNames-stripped published name. {@link DocLinkKind.OPERATION}: the contract class and
         * method name. Empty for the other kinds.
         */
        readonly owner: string,
        readonly ownerName: string,
        /** {@link DocLinkKind.TYPE}: the `.member` tail exactly as written (`.items`), else empty. */
        readonly member: string,
        /** {@link DocLinkKind.OPERATION}: the method's `@WpMcpTool` name, when it is a tool. */
        readonly mcpToolName: string | undefined,
        /** {@link DocLinkKind.UNRESOLVED}: why it names nothing publishable, in one clause. */
        readonly reason: string,
    ) {}
}

/** One `{@link}` a rendered output could not name. A renderer refuses every one, in one run. */
export class DocLinkProblem {
    constructor(
        /** Pointer-style `path/to/File.ts:12:5` of the link. */
        readonly location: string,
        /** The target as written. */
        readonly written: string,
        /** Why, in one clause. */
        readonly reason: string,
    ) {}

    toString(): string {
        return `${this.location} {@link ${this.written}} — ${this.reason}`;
    }
}

/**
 * How ONE rendered output names a link's target: the published schema name in THIS document, the
 * operationId, an MCP tool name. Undefined means the output does not publish the target, which the
 * resolver records as a {@link DocLinkProblem}.
 */
export interface DocLinkNaming {
    publishedName(link: DocLink): string | undefined;
}

/** Brackets one encoded link inside a model string. Private-use code points: no author types them. */
const OPEN = '';
const CLOSE = '';
const ENCODED = /([^]*)/g;

/**
 * The ONE grammar for a `{@link}` inside model prose (#1284).
 *
 * Every prose string the model carries — a description, a `@summary`, a `@returns`, an `@mcp` — holds
 * each link ENCODED in place, so concatenation, trimming and joining by any renderer cannot separate a
 * link from the sentence it sits in. A renderer resolves the string as it publishes it, with its own
 * {@link DocLinkNaming}, and every renderer emits the SAME spelling:
 *
 * | written | published |
 * |---|---|
 * | `{@link MenuDto}` | `` `Menu` `` (the published schema name) |
 * | `{@link MenuDto.items}` | `` `Menu.items` `` (the tail kept as written) |
 * | `{@link OrdersApi.fetchOrders}` | `` `fetchOrders` `` (the operationId; an MCP tool's name in a tool catalog) |
 * | `{@link OrdersApi.fetchOrders \| the order list}` | `the order list (`fetchOrders`)` |
 *
 * A markdown CODE SPAN, because OpenAPI descriptions are CommonMark: every renderer shows it as code,
 * and a docs site can turn a code span naming a known operationId or schema into a link. A labelled
 * link keeps the author's words AND the identity, so the reference survives into a site's hyperlink.
 *
 * A model string must never reach a published output unresolved; a renderer that forgets is caught by
 * {@link hasLinks}, which every published output is checked with.
 */
export class DocLinkText {
    /** `link`, encoded for a place in a model string. */
    // webpieces-disable no-function-outside-class -- static codec of the grammar this class owns
    static encode(link: DocLink): string {
        const fields = [
            link.kind,
            link.written,
            link.label ?? null,
            link.location,
            link.owner,
            link.ownerName,
            link.member,
            link.mcpToolName ?? null,
            link.reason,
        ];
        return `${OPEN}${JSON.stringify(fields)}${CLOSE}`;
    }

    /** True when `text` still holds an encoded link — a published output never may. */
    // webpieces-disable no-function-outside-class -- static codec of the grammar this class owns
    static hasLinks(text: string): boolean {
        return text.includes(OPEN);
    }

    /**
     * Every link in `text` as WRITTEN, in the published spelling: for a measurement that must not count
     * the encoding (a `@summary`'s length) and for a reader that publishes nothing.
     */
    // webpieces-disable no-function-outside-class -- static codec of the grammar this class owns
    static asWritten(text: string): string {
        return text.replace(ENCODED, (_all: string, body: string) => {
            const link = DocLinkText.decode(body);
            return DocLinkText.spell(link, link.written);
        });
    }

    /** Every encoded link in `text`, in order. */
    // webpieces-disable no-function-outside-class -- static codec of the grammar this class owns
    static linksIn(text: string): readonly DocLink[] {
        const links: DocLink[] = [];
        for (const match of text.matchAll(ENCODED)) {
            links.push(DocLinkText.decode(match[1] ?? ''));
        }
        return links;
    }

    /** `text` with every link published under the name `naming` gives it; misses go to `problems`. */
    // webpieces-disable no-function-outside-class -- static codec of the grammar this class owns
    static resolve(
        text: string,
        naming: DocLinkNaming,
        output: string,
        problems: DocLinkProblem[],
    ): string {
        return text.replace(ENCODED, (_all: string, body: string) => {
            const link = DocLinkText.decode(body);
            const name =
                link.kind === DocLinkKind.UNRESOLVED ? undefined : naming.publishedName(link);
            if (name === undefined) {
                problems.push(
                    new DocLinkProblem(link.location, link.written, DocLinkText.why(link, output)),
                );
                return DocLinkText.spell(link, link.written);
            }
            return DocLinkText.spell(
                link,
                link.kind === DocLinkKind.TYPE ? `${name}${link.member}` : name,
            );
        });
    }

    /** The one published spelling — see the class doc. */
    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static spell(link: DocLink, name: string): string {
        const code = `\`${name}\``;
        return link.label === undefined ? code : `${link.label} (${code})`;
    }

    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static why(link: DocLink, output: string): string {
        switch (link.kind) {
            case DocLinkKind.TYPE:
                return `type ${link.ownerName} is not published in ${output}`;
            case DocLinkKind.OPERATION:
                return `operation ${link.owner}.${link.ownerName} is not published in ${output}`;
            default:
                return link.reason;
        }
    }

    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static decode(body: string): DocLink {
        const f = JSON.parse(body) as (string | null)[];
        return new DocLink(
            f[0] as DocLinkKind,
            f[1] ?? '',
            f[2] ?? undefined,
            f[3] ?? '',
            f[4] ?? '',
            f[5] ?? '',
            f[6] ?? '',
            f[7] ?? undefined,
            f[8] ?? '',
        );
    }
}
