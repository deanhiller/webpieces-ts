import { DocumentedApiKey, DocumentedApiKeyCredential } from '@webpieces/api-doc-model';
import { JsonObject, JsonValue } from '../json/JsonObject';
import { OpenApiGenerationError } from '../OpenApiGenerationError';

/**
 * `components.securitySchemes` and the `security` requirement, DERIVED from the contract's own
 * `@WpAuthApiKey(regime, credentials)`. The manifest contributes the published KEYS and nothing else.
 *
 * ## Why the schemes are not in the manifest
 *
 * A `components.securitySchemes` block in a JSON file would be a second copy of header names the
 * running server never reads — and nothing could contradict it. Deriving them from the decorator
 * means the published document and the hook that enforces the credential are the same declaration,
 * so the document cannot say `x-api-key` while the server checks `x-partner-key`. The manifest keeps
 * the KEYS because a scheme key is partner-visible naming, which is a product decision.
 *
 * ## ONE requirement object holding every scheme, never a list of one-key objects
 *
 * OpenAPI's `security` is a list of ALTERNATIVES, and each alternative is an object whose keys must
 * ALL be satisfied. So:
 *
 * ```
 * [{ PartnerApiKey: [], PartnerOrg: [] }]   // AND — present both. What a real regime means.
 * [{ PartnerApiKey: [] }, { PartnerOrg: [] }]  // OR — "either header alone suffices". A lie.
 * ```
 *
 * The second form is the dangerous default because it is what "a list of credentials" reads like,
 * and NO BUILD COULD CONTRADICT IT: the document would be well-formed, the tooling green, and a
 * partner told they may skip the organization header. Hence one object, always.
 */
export class SecurityDeriver {
    /** Every scheme, keyed by the manifest's published names, in declaration order. */
    schemes(
        apiKey: DocumentedApiKey,
        schemeNames: readonly string[],
        manifestPath: string,
    ): JsonObject {
        if (schemeNames.length !== apiKey.credentials.length) {
            throw new OpenApiGenerationError(
                `securitySchemeNames has ${schemeNames.length} name(s) but the '${apiKey.regime}' ` +
                    `regime declares ${apiKey.credentials.length} credential(s)`,
                manifestPath,
                'Give exactly one published scheme name per credential, in the order the ' +
                    'contract declares them. The names are partner-visible; the credentials are not ' +
                    'the manifest to choose.',
            );
        }
        const schemes = new JsonObject();
        for (let i = 0; i < schemeNames.length; i++) {
            schemes.set(schemeNames[i]!, this.scheme(apiKey.credentials[i]!, manifestPath));
        }
        return schemes;
    }

    /**
     * ONE credential -> ONE scheme. The two shapes are STRUCTURALLY different documents, which is
     * exactly why `ApiKeyCredential` is a union in the framework rather than one optional field.
     */
    private scheme(credential: DocumentedApiKeyCredential, manifestPath: string): JsonObject {
        if (credential.location === 'bearer') {
            return new JsonObject()
                .set('type', 'http')
                .set('scheme', 'bearer')
                .set('description', credential.description);
        }
        if (credential.location !== 'header') {
            throw new OpenApiGenerationError(
                `unknown api-key credential location '${credential.location}'`,
                manifestPath,
                "A credential rides `in: 'header'` with a name, or `in: 'bearer'`.",
            );
        }
        if (credential.name === undefined) {
            throw new OpenApiGenerationError(
                'a header api-key credential declares no header name',
                manifestPath,
                "Write `{ in: 'header', name: 'x-api-key' }`; a header credential with no name " +
                    'is unusable and cannot be published.',
            );
        }
        return new JsonObject()
            .set('type', 'apiKey')
            .set('in', 'header')
            .set('name', credential.name)
            .set('description', credential.description);
    }

    /** The ONE AND-ed requirement — see the class doc for why it is one object and not a list. */
    requirement(schemeNames: readonly string[]): readonly JsonValue[] {
        const anded = new JsonObject();
        for (const name of schemeNames) {
            anded.set(name, []);
        }
        return [anded];
    }
}
