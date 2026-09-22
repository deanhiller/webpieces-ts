import * as fs from 'node:fs';
import * as path from 'node:path';
import { GeneratedDocument, GeneratedDocuments } from '../generate/GenerationInputs';
import { JsonWriter } from '../json/JsonWriter';
import { YamlWriter } from '../json/YamlWriter';

/** One file this generation pass produces: its name, and its exact bytes. */
export class GeneratedArtifact {
    constructor(
        readonly fileName: string,
        readonly text: string,
    ) {}
}

/** Which serializations to write. Orthogonal to WHICH documents `@ApiType` selected. */
export type OutputFormat = 'json' | 'yaml' | 'both';

/**
 * The generated documents, serialized.
 *
 * | file | audience |
 * |---|---|
 * | `full-private-openapi.json` | internal. Every contract declaring `SVC_TO_SVC`, hidden methods included. Nothing renders it for humans |
 * | `public-openapi.json` | customers. Contracts declaring `EXTERNAL_CUSTOMER`, minus every `{ hidden: true }` method |
 * | `mcp-openapi.json` | agents. Contracts declaring `MCP`, carrying the `x-mcp-*` extensions |
 *
 * A document is written only when some contract declared its type, which is decided by the generator
 * — this class writes what it is given. `--format` then chooses `.json`, `.yaml` or both from the
 * SAME in-memory document, so the two serializations cannot disagree.
 *
 * ## Why the goldens commit JSON only
 *
 * Committing both would double the review surface every decorator change has to be diffed against,
 * for a second file that is the first one restated. One spec parses each emitted YAML and asserts
 * deep equality with its JSON counterpart instead, which proves the YAML is correct without asking
 * anybody to read it.
 *
 * ## Why the JSON documents ARE committed
 *
 * `diff full-private-openapi.json public-openapi.json` is the complete list of what these contracts
 * do not show a customer. That only works as a review device if both files are in the tree, so hiding
 * a method shows up as a diff in the PR that hides it.
 */
export class ArtifactWriter {
    private readonly json = new JsonWriter();
    private readonly yaml = new YamlWriter();

    artifacts(documents: GeneratedDocuments, format: OutputFormat): readonly GeneratedArtifact[] {
        const artifacts: GeneratedArtifact[] = [];
        for (const generated of documents.documents) {
            if (format !== 'yaml') {
                artifacts.push(
                    new GeneratedArtifact(
                        `${generated.fileName}.json`,
                        this.json.write(generated.document),
                    ),
                );
            }
            if (format !== 'json') {
                artifacts.push(
                    new GeneratedArtifact(
                        `${generated.fileName}.yaml`,
                        this.yaml.write(generated.document),
                    ),
                );
            }
        }
        return artifacts;
    }

    /** Write them all, creating `outDir` if it does not exist. Returns the absolute paths written. */
    write(outDir: string, artifacts: readonly GeneratedArtifact[]): readonly string[] {
        fs.mkdirSync(outDir, { recursive: true });
        return artifacts.map((artifact: GeneratedArtifact) => {
            const file = path.join(outDir, artifact.fileName);
            fs.writeFileSync(file, artifact.text, 'utf8');
            return file;
        });
    }

    /** The document objects, for a caller that wants them rather than their bytes. */
    documentsOf(documents: GeneratedDocuments): readonly GeneratedDocument[] {
        return documents.documents;
    }
}
