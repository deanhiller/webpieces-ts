import { minimatch } from 'minimatch';
import type { DocumentedType } from './ApiDocModel';
import { ApiDocExtractionError } from '../extract/ApiDocExtractionError';

/** Ordered declaration-file globs and exact trailing suffixes to remove from published schema names. */
export class SchemaNameEntry {
    constructor(
        readonly paths: readonly string[],
        readonly stripSuffixes: readonly string[],
    ) {}
}

export class SchemaNames {
    constructor(private readonly entries: readonly SchemaNameEntry[]) {}

    nameOf(name: string, file: string): string {
        const normalized = file.replace(/\\/g, '/');
        const entry = this.entries.find((candidate: SchemaNameEntry) =>
            candidate.paths.some((glob: string) =>
                minimatch(normalized, glob.replace(/\\/g, '/'), { dot: true }),
            ),
        );
        const suffix = entry?.stripSuffixes.find(
            (each: string) => each.length > 0 && name.length > each.length && name.endsWith(each),
        );
        return suffix === undefined ? name : name.slice(0, -suffix.length);
    }

    /** A package's emitted namespace must never conflate two declarations after stripping. */
    validate(types: Iterable<DocumentedType>): void {
        const seen = new Map<string, DocumentedType>();
        for (const type of types) {
            const key = type.schemaName;
            const first = seen.get(key);
            if (
                first !== undefined &&
                (first.name !== type.name ||
                    (first.location !== type.location &&
                        (first.name !== first.schemaName || type.name !== type.schemaName)))
            ) {
                throw new ApiDocExtractionError(
                    `schema name '${type.schemaName}' collides: '${first.name}' at ${first.location} and '${type.name}' at ${type.location}`,
                    type.location,
                    'Choose distinct published names or change the schemaNames stripping entries; both declarations must remain distinguishable.',
                );
            }
            seen.set(key, type);
        }
    }
}
