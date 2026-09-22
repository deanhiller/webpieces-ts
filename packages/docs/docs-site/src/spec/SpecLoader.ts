import * as fs from 'node:fs';
import { DocsSiteError } from '../DocsSiteError';
import { JsonNode } from './JsonNode';

/**
 * Reads the OpenAPI document off disk.
 *
 * It accepts 3.0 and 3.1 alike, and beyond the version it validates NOTHING: this package renders
 * any CONFORMING document, and a renderer that re-validates is a second opinion about the spec that
 * some other tool's document will eventually fail for no reason a reader can act on.
 *
 * ## Why SWAGGER 2.0 is refused rather than attempted
 *
 * 2.0 is a different document: schemas live in `definitions`, not `components.schemas`, and there is
 * no `webhooks` block. Reading one with this reader finds none of those keys and succeeds — writing
 * a site with every operation's fields missing and no schema pages, which is indistinguishable from
 * a contract nobody documented. So the version is checked for `3.`, and a 2.0 document is refused
 * with the converter named. A wrong site is worse than no site, because only one of the two sends
 * somebody looking for the bug.
 */
export class SpecLoader {
    load(file: string): JsonNode {
        if (!fs.existsSync(file)) {
            throw new DocsSiteError(
                'no OpenAPI document there',
                file,
                'Point --spec at a generated OpenAPI 3.0 or 3.1 JSON document.',
            );
        }
        const root = new JsonNode(this.parse(file, fs.readFileSync(file, 'utf8')));
        const version = root.text('openapi');
        if (version === undefined) {
            throw new DocsSiteError(
                this.wrongDocumentMessage(root),
                file,
                'Point --spec at the OpenAPI document itself — for a webpieces app, one of the files wp-openapi wrote.',
            );
        }
        if (!version.startsWith('3.')) {
            throw new DocsSiteError(
                `this renders OpenAPI 3.0 and 3.1, and that document declares "${version}"`,
                file,
                'Convert the document to 3.0 or 3.1 first — 3.x keeps its schemas under components.schemas, which is where this reads them.',
            );
        }
        return root;
    }

    /**
     * A Swagger 2.0 document is named in the message, because "declares no openapi version" would
     * send somebody looking for a missing key in a file that is simply a different format.
     */
    private wrongDocumentMessage(root: JsonNode): string {
        const swagger = root.text('swagger');
        if (swagger !== undefined) {
            return `that is a Swagger ${swagger} document, and this renders OpenAPI 3.0 and 3.1`;
        }
        return 'that JSON file declares no "openapi" version, so it is not an OpenAPI document';
    }

    // webpieces-disable no-any-unknown -- JSON.parse returns a foreign value; JsonNode is the narrowing
    private parse(file: string, source: string): unknown {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- re-thrown below as a stated failure
        try {
            return JSON.parse(source);
            // webpieces-disable no-any-unknown -- the catch binding, which TypeScript types for us
        } catch (err: unknown) {
            //const error = toError(err);
            throw new DocsSiteError(
                `the OpenAPI document is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
                file,
                'Regenerate the document, or fix the JSON syntax, and re-run.',
            );
        }
    }
}
