import * as fs from 'fs';
import { OpenApiImportError } from '../OpenApiImportError';
import { toError } from '../toError';
import { SpecNode } from './SpecNode';

/** Reads one JSON file the importer was pointed at — the import file or the vendor's spec. */
export class JsonFile {
    /**
     * @param what  what the file is, for the refusal ("import file", "OpenAPI spec")
     * @param cure  how the caller points the importer at the right file
     */
    read(absolute: string, what: string, cure: string): SpecNode {
        if (!fs.existsSync(absolute)) {
            throw new OpenApiImportError(`${what} not found`, absolute, cure);
        }
        const text = fs.readFileSync(absolute, 'utf8');
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- a parse failure becomes the one typed refusal, carrying its cause
        try {
            return new SpecNode(JSON.parse(text));
        } catch (err: unknown) {
            const error = toError(err);
            throw new OpenApiImportError(
                `${what} is not valid JSON (YAML and Swagger 2.0 are not supported in v1)`,
                absolute,
                'Convert it to OpenAPI 3.0/3.1 JSON first.',
                error,
            );
        }
    }
}
