import { OpenApiGenerationError } from '../OpenApiGenerationError';
import { ContractModel } from './GenerationInputs';

/**
 * WHICH contract's JSDoc is a tag's `description` (#1292).
 *
 * A manifest commonly files a webhook contract under the same tag as its API contract, so the events
 * appear in the same sidebar section. The webhook contract JOINS that section; it does not define it.
 * The section intro used to be whichever contract was rendered LAST — usually the webhook — so the
 * "Orders" section was introduced by `OrdersWebhookApi`'s prose. The rule:
 *
 * - `tags[<tag>].description` comes from the ONE non-webhook contract carrying the tag.
 * - Two non-webhook contracts on one tag is refused, naming every one: there is no honest way to say
 *   which of them introduces the section, and a document that guessed would publish one contract's
 *   intro over the other's operations.
 * - A tag carried only by webhook contracts takes the FIRST webhook contract's JSDoc, in manifest
 *   order.
 */
export class TagOwnership {
    /**
     * Refuse a manifest filing two or more non-webhook contracts under one tag. Judged over EVERY
     * contract the manifest names, not per document: the ownership of a section is the manifest's
     * decision, and it must not depend on which `@ApiType`s happen to put both in one file.
     */
    refuseSharedOwners(contracts: readonly ContractModel[], manifestPath: string): void {
        const owners = new Map<string, ContractModel[]>();
        for (const contract of contracts) {
            if (contract.entry.isWebhook()) {
                continue;
            }
            const tag = contract.entry.tag;
            owners.set(tag, [...(owners.get(tag) ?? []), contract]);
        }
        const shared: string[] = [];
        for (const tag of Array.from(owners.keys())) {
            const list = owners.get(tag)!;
            if (list.length > 1) {
                const names = list.map(
                    (each: ContractModel) => `${each.model.contractName} (${each.file})`,
                );
                shared.push(`tag '${tag}': ${names.join(' and ')}`);
            }
        }
        if (shared.length === 0) {
            return;
        }
        throw new OpenApiGenerationError(
            `${shared.length} tag(s) are carried by more than one non-webhook contract, so no one ` +
                "contract's JSDoc can introduce the section",
            manifestPath,
            'Give each non-webhook contract its own "tag" in the manifest\'s apis[]. A webhook ' +
                'contract may share its API contract\'s tag ("kind": "webhook"); two API contracts ' +
                'may not.',
            shared,
        );
    }

    /**
     * The description of `tag` in a document holding `contracts` (in manifest order): the non-webhook
     * owner's JSDoc, else the first webhook contract's. Undefined when that contract has no JSDoc.
     */
    descriptionOf(tag: string, contracts: readonly ContractModel[]): string | undefined {
        const carrying = contracts.filter((each: ContractModel) => each.entry.tag === tag);
        const owner =
            carrying.find((each: ContractModel) => !each.entry.isWebhook()) ?? carrying[0];
        if (owner === undefined) {
            return undefined;
        }
        const prose = owner.model.description.trim();
        return prose === '' ? undefined : owner.model.description;
    }
}
