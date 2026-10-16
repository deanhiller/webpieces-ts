import { DocumentedEndpoint } from '@webpieces/api-doc-model';
import { OpenApiGenerationError } from '../OpenApiGenerationError';
import { ContractModel } from './GenerationInputs';
import { DocumentSelection } from './DocumentSelection';
import { SuccessBody } from './SuccessBody';

/**
 * The refusal for a published operation whose method has no `@returns` (#1292).
 *
 * A success response's `description` is REQUIRED by OpenAPI, and it used to be the hard-coded
 * `"Success."` on every operation — a required field holding filler, which tells a partner nothing
 * about what the body means. The method's `@returns` text is published there instead, so a missing
 * one is refused rather than papered over. Every offender is named in ONE run, before anything is
 * rendered, the same as {@link StackedJsDocGuard}; there is deliberately no flag to switch it off.
 *
 * ## What it judges
 *
 * - EVERY document the run writes — `full-private-openapi`, `public-openapi` AND the MCP output
 *   (`mcp-openapi.json` and the `mcp-<Contract>-tools.json` catalogs, whose tools are exactly the MCP
 *   document's tool operations). An agent reading `tools/list` is told what a tool returns by the same
 *   `@returns` sentence a partner reads, published as the catalog's `outputSchema.description`.
 * - Only an operation whose success response has a BODY. A `Promise<void>` method has nothing for
 *   `@returns` to describe; its response keeps the derived acknowledgement sentence.
 * - Every operation the document would publish, webhooks included: a webhook whose partner returns a
 *   body publishes that body's description the same way.
 */
export class MissingReturnsGuard {
    private readonly body = new SuccessBody();

    /** Refuse when any selected, body-carrying operation of `contracts` has no `@returns`. */
    refuse(contracts: readonly ContractModel[], manifestPath: string): void {
        const missing = new Map<string, string>();
        for (const selection of DocumentSelection.all()) {
            for (const contract of contracts) {
                if (!selection.acceptsContract(contract.model)) {
                    continue;
                }
                this.collect(contract, selection, missing);
            }
        }
        if (missing.size === 0) {
            return;
        }
        throw new OpenApiGenerationError(
            `${missing.size} published operation(s) have no @returns, so their success response ` +
                'has no description to publish',
            manifestPath,
            'Add a `@returns <what the response body is>` line to the JSDoc of each method named ' +
                "below. It is published as the success response's description, so write the " +
                'sentence a partner reads, not filler.',
            Array.from(missing.values()),
        );
    }

    private collect(
        contract: ContractModel,
        selection: DocumentSelection,
        missing: Map<string, string>,
    ): void {
        const model = contract.model;
        for (const endpoint of model.endpoints) {
            if (!selection.acceptsEndpoint(endpoint) || !this.lacksReturns(endpoint)) {
                continue;
            }
            const name = `${model.contractName}.${endpoint.methodName}`;
            if (!missing.has(name)) {
                missing.set(name, `${name} (${contract.file})`);
            }
        }
    }

    private lacksReturns(endpoint: DocumentedEndpoint): boolean {
        if (this.body.isVoid(endpoint.response)) {
            return false;
        }
        const text = endpoint.returnsDescription;
        return text === undefined || text.trim() === '';
    }
}
