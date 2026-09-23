import * as ts from 'typescript';
import { ApiType, InvalidEndpointForMcp, MCP, WpMcpTool } from '@webpieces/core-util';
import { DocumentedEndpoint } from '../model/ApiDocModel';
import { ApiDocExtractionError } from './ApiDocExtractionError';
import { SourceLocation } from './SourceLocation';

/**
 * The decorator names, taken from the REAL SYMBOLS for the reason `ApiDocExtractor`'s constants give
 * at length: a literal that stops matching after a rename empties a document with the build green.
 */
const API_TYPE = ApiType.name;
const MCP_TOOL = WpMcpTool.name;
const MCP_INVALID = InvalidEndpointForMcp.name;

/**
 * MCP membership has exactly ONE spelling, and this is the BUILD-TIME half of enforcing it
 * (`assertApiTypeMatchesMcpTools` in `@webpieces/core-util` is the wiring-time half).
 *
 * Declared in two places, the two can disagree — and the disagreement is invisible, because each
 * declaration is individually valid. That is the defect this whole epic exists to remove, so it
 * fails the DOCUMENT build rather than producing one that quietly lists the wrong tools.
 *
 * `@InvalidEndpointForMcp` (#1014) sits OUTSIDE the biconditional and is checked here too. A method
 * declared permanently unusable as a tool is neither required to carry `@WpMcpTool` nor permitted
 * to, and a contract whose every endpoint is so declared must not name MCP at all — the cure there
 * is the opposite one, so it gets its own sentence rather than being folded into "no method carries
 * @WpMcpTool".
 *
 * Split out of `ApiDocExtractor`, which owns the walk and is at its file-size limit.
 */
// webpieces-disable no-function-outside-class -- module entry point, mirrors the extractor's own split-out helpers
export function assertApiTypeMatchesMcpTools(
    contract: ts.ClassDeclaration,
    apiTypes: readonly string[],
    endpoints: readonly DocumentedEndpoint[],
): void {
    const tools = endpoints.filter((e: DocumentedEndpoint) => e.mcpTool !== undefined);
    const excluded = endpoints.filter((e: DocumentedEndpoint) => e.invalidForMcp !== undefined);
    const declaresMcp = apiTypes.includes(MCP);
    assertNoToolIsAlsoExcluded(contract, tools);
    if (declaresMcp && tools.length === 0 && excluded.length === endpoints.length) {
        throw new ApiDocExtractionError(
            `@${API_TYPE} names MCP but EVERY endpoint is @${MCP_INVALID}`,
            SourceLocation.of(contract),
            `Drop MCP from the @${API_TYPE} list — a contract whose every method is permanently ` +
                'outside MCP does not feed the MCP document.',
        );
    }
    if (declaresMcp && tools.length === 0) {
        throw new ApiDocExtractionError(
            `@${API_TYPE} names MCP but no method carries @${MCP_TOOL}`,
            SourceLocation.of(contract),
            `Add @${MCP_TOOL}('<stable_tool_name>') to the methods agents may call, or drop MCP ` +
                `from the @${API_TYPE} list.`,
        );
    }
    if (!declaresMcp && tools.length > 0) {
        const named = tools.map((e: DocumentedEndpoint) => e.methodName).join(', ');
        throw new ApiDocExtractionError(
            `@${MCP_TOOL} is on ${named} but @${API_TYPE} does not name MCP`,
            SourceLocation.of(contract),
            `Add MCP to the @${API_TYPE} list — membership has ONE spelling, so a tool on a ` +
                'contract nobody published to agents is a contradiction, not a hint.',
        );
    }
}

/**
 * `@WpMcpTool` and `@InvalidEndpointForMcp` on ONE method is a contradiction, not a precedence rule.
 *
 * Resolving it either way would make the pair a second spelling of a decision that already has one,
 * and whichever way it resolved, half the readers of that method would be wrong about what it does.
 */
// webpieces-disable no-function-outside-class -- private assert of the entry point above, beside it
function assertNoToolIsAlsoExcluded(
    contract: ts.ClassDeclaration,
    tools: readonly DocumentedEndpoint[],
): void {
    const both = tools
        .filter((e: DocumentedEndpoint) => e.invalidForMcp !== undefined)
        .map((e: DocumentedEndpoint) => e.methodName);
    if (both.length === 0) return;
    throw new ApiDocExtractionError(
        `@${MCP_TOOL} and @${MCP_INVALID} are BOTH on ${both.join(', ')}`,
        SourceLocation.of(contract),
        'They contradict each other — one publishes the method to agents and the other declares it ' +
            'permanently unusable as a tool. Delete whichever one is wrong.',
    );
}
