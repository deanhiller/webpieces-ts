import { EndpointSummary } from '@webpieces/api-doc-model';
import { OpenApiGenerationError } from '../OpenApiGenerationError';
import { ContractModel } from './GenerationInputs';
import { DocumentSelection } from './DocumentSelection';

/**
 * The refusal for a published operation whose method has no usable `@summary` (#1296).
 *
 * The summary is the endpoint's short title, and it has ONE source: the `@summary` JSDoc tag. It is
 * published as the OpenAPI operation's `summary` — the page heading and sidebar label a docs site
 * shows — and, for a tool, as MCP `Tool.title` AND `annotations.title`. It used to be the bare method
 * name in OpenAPI and a second, decorator-argument title in MCP, and the two drifted; the decorator
 * argument is gone. A missing, multi-line or over-long (> {@link EndpointSummary.MAX_LENGTH}
 * characters) summary is refused rather than papered over, and every offender is named in ONE run,
 * before anything is rendered — the same shape as {@link MissingReturnsGuard}. There is deliberately
 * no flag to switch it off: projects that predate it fail until they add the line.
 *
 * ## What it judges
 *
 * Every operation EVERY document of the run would publish — `full-private-openapi`, `public-openapi`
 * and the MCP output (`mcp-openapi.json` and the `mcp-<Contract>-tools.json` catalogs) — served routes
 * and webhooks alike.
 */
export class SummaryGuard {
    /** Refuse when any selected operation of `contracts` has no usable `@summary`. */
    refuse(contracts: readonly ContractModel[], manifestPath: string): void {
        const offenders = new Map<string, string>();
        for (const selection of DocumentSelection.all()) {
            for (const contract of contracts) {
                if (selection.acceptsContract(contract.model)) {
                    this.collect(contract, selection, offenders);
                }
            }
        }
        if (offenders.size === 0) {
            return;
        }
        throw new OpenApiGenerationError(
            `${offenders.size} published operation(s) have no usable @summary, so they have no short ` +
                'title to publish as the OpenAPI summary or the MCP tool title',
            manifestPath,
            EndpointSummary.cure(),
            Array.from(offenders.values()),
        );
    }

    private collect(
        contract: ContractModel,
        selection: DocumentSelection,
        offenders: Map<string, string>,
    ): void {
        const model = contract.model;
        for (const endpoint of model.endpoints) {
            if (!selection.acceptsEndpoint(endpoint)) {
                continue;
            }
            const problem = EndpointSummary.problemWith(endpoint.summary);
            const name = `${model.contractName}.${endpoint.methodName}`;
            if (problem !== undefined && !offenders.has(name)) {
                offenders.set(name, `${name} ${problem} (${contract.file})`);
            }
        }
    }
}
