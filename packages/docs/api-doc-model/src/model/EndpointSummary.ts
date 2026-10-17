import { DocLinkText } from './DocLink';

/**
 * THE rule for an endpoint's `@summary` JSDoc tag (#1296): present, one line, at most 100 characters.
 *
 * The summary is the endpoint's short title. It is published as the OpenAPI operation `summary` — what
 * a docs site heads the page with and labels the sidebar with — and as MCP `Tool.title` and
 * `annotations.title`, which clients and the Claude Connectors Directory show. A heading and a sidebar
 * label is one line, so a second line is refused rather than joined, and 100 characters is a house
 * rule (no spec sets one) that keeps it a label rather than a sentence.
 *
 * It is here, beside the model, so the OpenAPI generator's guard, the MCP renderer and
 * `api-rules-for-mcp` all ask the SAME question of the same text.
 */
export class EndpointSummary {
    /** The longest summary a heading or sidebar label should carry. */
    static readonly MAX_LENGTH = 100;

    /** What is wrong with `summary`, in one clause, or undefined when it is a legal summary. */
    // webpieces-disable no-function-outside-class -- static helper of this class; the rule has no state
    static problemWith(summary: string | undefined): string | undefined {
        if (summary === undefined || summary.trim() === '') {
            return 'has no @summary';
        }
        if (/[\r\n]/.test(summary)) {
            return '@summary spans more than one line';
        }
        // A `{@link}` is measured as it reads, never as its encoding in the model (#1284).
        const length = DocLinkText.asWritten(summary).length;
        if (length > EndpointSummary.MAX_LENGTH) {
            return `@summary is ${length} characters, over the ${EndpointSummary.MAX_LENGTH}-character limit`;
        }
        return undefined;
    }

    /** The one cure every refusal of a summary prints. */
    // webpieces-disable no-function-outside-class -- static helper of this class; the rule has no state
    static cure(): string {
        return (
            "Write a `@summary <short title>` line in the method's JSDoc: one line, at most " +
            `${EndpointSummary.MAX_LENGTH} characters, e.g. \`@summary Fetch your orders\`. It is ` +
            "published as the OpenAPI operation's summary (a docs site's page heading and sidebar " +
            'label) and as the MCP tool title and annotations.title; the rest of the JSDoc stays the ' +
            'description.'
        );
    }
}
