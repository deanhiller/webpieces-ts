import { McpToolName } from '@webpieces/core-util';
import { OpenApiGenerationError } from '../OpenApiGenerationError';
import { ContractModel } from './GenerationInputs';
import { DocumentSelection } from './DocumentSelection';

/**
 * The refusal for an MCP tool whose stable protocol name the Claude Connectors Directory would refuse
 * (#1296): longer than {@link McpToolName.MAX_LENGTH} characters, or using a character outside
 * `[A-Za-z0-9_-]`.
 *
 * MCP itself allows up to 128 characters and a dot, but a server with even one longer name cannot be
 * listed in the Directory, and a tool name is the protocol identity agents save — renaming it later
 * breaks them. So it is refused at generation, where the author can still pick the final name, and
 * every offender of the run is named at once, before anything is rendered. The rule itself is
 * {@link McpToolName}, the one `@WpMcpTool`, the catalog codec and `api-rules-for-mcp` also apply.
 *
 * It judges every `@WpMcpTool` of every contract the MCP output selects — exactly the tools
 * `mcp-openapi.json` and the `mcp-<Contract>-tools.json` catalogs would publish.
 */
export class McpToolNameGuard {
    /** Refuse when any MCP tool of `contracts` has an illegal name. */
    refuse(contracts: readonly ContractModel[], manifestPath: string): void {
        const selection = DocumentSelection.mcp();
        const offenders: string[] = [];
        for (const contract of contracts) {
            if (!selection.acceptsContract(contract.model)) {
                continue;
            }
            for (const endpoint of contract.model.endpoints) {
                const tool = endpoint.mcpTool;
                if (tool === undefined || !selection.acceptsEndpoint(endpoint)) {
                    continue;
                }
                const problem = McpToolName.problemWith(tool.name);
                if (problem !== undefined) {
                    offenders.push(
                        `${contract.model.contractName}.${endpoint.methodName}: tool name ` +
                            `'${tool.name}' ${problem} (${contract.file})`,
                    );
                }
            }
        }
        if (offenders.length === 0) {
            return;
        }
        throw new OpenApiGenerationError(
            `${offenders.length} MCP tool name(s) would be refused by the Claude Connectors Directory`,
            manifestPath,
            McpToolName.cure(),
            offenders,
        );
    }
}
