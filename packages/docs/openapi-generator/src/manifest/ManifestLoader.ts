import * as fs from 'node:fs';
import * as path from 'node:path';
import { OpenApiGenerationError } from '../OpenApiGenerationError';
import { JsonReader } from './JsonReader';
import { SchemaNameEntry } from '@webpieces/api-doc-model';
import {
    ApiEntry,
    ComponentsManifest,
    ErrorResponseEntry,
    ErrorsEntry,
    OpenApiManifest,
    ResponseHeaderEntry,
    ServerEntry,
} from './OpenApiManifest';

/** The only `kind` an api entry may declare. Anything else is a typo, and typos are refused. */
const WEBHOOK = 'webhook';

/**
 * The only `kind` a MANIFEST may declare (#1058): a DTO library's components-only document. A
 * manifest with no `kind` is a contract library's, exactly as before.
 */
const COMPONENTS = 'components';

/** The deleted string-constant spelling of a response header's name (#1249). */
const RETIRED_NAME_CONSTANT = 'nameConstant';

/** Keys a components manifest must not carry, each with why — a contract-manifest key is a mix-up. */
const NOT_IN_COMPONENTS: ReadonlyMap<string, string> = new Map<string, string>([
    ['apis', 'a components document has no paths; list the library\'s entry files in "entries"'],
    [
        'version',
        "a library document's info.version is the package version, read from its package.json",
    ],
    ['servers', 'a components document has no operations to serve'],
    ['errors', 'the error contract belongs to a contract document'],
    ['responseHeaders', 'response headers belong to a contract document'],
    ['securitySchemeNames', 'security belongs to a contract document'],
]);

/**
 * Read `openapi.manifest.json` into {@link OpenApiManifest}.
 *
 * It deals only in {@link JsonReader}, which is where the "came off disk, not yet checked" state is
 * concentrated — so nothing in this file, or anywhere downstream, handles an unnarrowed value.
 *
 * Every rejection is a HARD FAILURE naming the field. A published document quietly missing a section
 * is indistinguishable, from outside, from an API that genuinely has no error contract.
 */
export class ManifestLoader {
    /**
     * True for a DTO library's `"kind": "components"` manifest, false for a contract library's (no
     * `kind`). Any other `kind` is refused: a typo there would otherwise render the wrong document.
     */
    isComponents(manifestPath: string): boolean {
        const kind = this.read(manifestPath).optionalString('kind');
        if (kind === undefined) {
            return false;
        }
        if (kind !== COMPONENTS) {
            throw new OpenApiGenerationError(
                `unknown manifest kind '${kind}'`,
                manifestPath,
                `The only manifest kind is "${COMPONENTS}", for a DTO library's components document. ` +
                    "Leave it out for a contract library's manifest.",
            );
        }
        return true;
    }

    /** A DTO library's components manifest. See {@link ComponentsManifest}. */
    loadComponents(manifestPath: string): ComponentsManifest {
        const raw = this.read(manifestPath);
        for (const key of NOT_IN_COMPONENTS.keys()) {
            const why = NOT_IN_COMPONENTS.get(key)!;
            if (raw.has(key)) {
                throw new OpenApiGenerationError(
                    `a "kind": "${COMPONENTS}" manifest declares '${key}'`,
                    raw.where,
                    `Delete it — ${why}.`,
                );
            }
        }
        const entries = raw.strings('entries');
        if (entries.length === 0) {
            throw new OpenApiGenerationError(
                "'entries' is empty",
                raw.where,
                'Name the library\'s entry files, e.g. "entries": ["src/index.ts"]; the document holds every type they export.',
            );
        }
        return new ComponentsManifest(raw.string('title'), entries, this.schemaNames(raw));
    }

    private read(manifestPath: string): JsonReader {
        if (!fs.existsSync(manifestPath)) {
            throw new OpenApiGenerationError(
                'no manifest at this path',
                manifestPath,
                'Pass --manifest pointing at an openapi.manifest.json that exists.',
            );
        }
        return JsonReader.parseFile(fs.readFileSync(manifestPath, 'utf8'), manifestPath);
    }

    /** @param manifestPath absolute path to a CONTRACT library's `openapi.manifest.json`. */
    load(manifestPath: string): OpenApiManifest {
        if (this.isComponents(manifestPath)) {
            throw new OpenApiGenerationError(
                `this is a "kind": "${COMPONENTS}" manifest, not a contract manifest`,
                manifestPath,
                'Render it as a components document (wp-openapi does so on its own when it reads the kind).',
            );
        }
        const raw = this.read(manifestPath);
        return new OpenApiManifest(
            raw.string('title'),
            raw.string('version'),
            this.servers(raw),
            raw.optionalString('descriptionFile'),
            this.apis(raw),
            raw.strings('securitySchemeNames'),
            this.errors(raw),
            this.responseHeaders(raw),
            this.schemaNames(raw),
        );
    }

    private servers(raw: JsonReader): readonly ServerEntry[] {
        return raw
            .objects('servers')
            .map(
                (server: JsonReader) =>
                    new ServerEntry(server.string('url'), server.optionalString('description')),
            );
    }

    private schemaNames(raw: JsonReader): readonly SchemaNameEntry[] {
        return raw.objects('schemaNames').map((entry: JsonReader) => {
            const paths = entry.strings('paths');
            const suffixes = entry.strings('stripSuffixes');
            if (
                paths.length === 0 ||
                paths.some((glob: string) => glob.trim() === '') ||
                !entry.has('stripSuffixes') ||
                suffixes.some((suffix: string) => suffix.length === 0)
            ) {
                throw new OpenApiGenerationError(
                    'invalid schemaNames entry',
                    raw.where,
                    'Provide non-empty paths and an explicit stripSuffixes array of non-empty suffixes (or [] to preserve names). First matching path wins.',
                );
            }
            return new SchemaNameEntry(
                paths.map((glob: string) => path.resolve(path.dirname(raw.where), glob)),
                suffixes,
            );
        });
    }

    private apis(raw: JsonReader): readonly ApiEntry[] {
        const entries = raw
            .objects('apis')
            .map(
                (api: JsonReader) =>
                    new ApiEntry(
                        api.string('entry'),
                        api.string('tag'),
                        api.optionalString('kind'),
                    ),
            );
        if (entries.length === 0) {
            throw new OpenApiGenerationError(
                "'apis' is empty",
                raw.where,
                'List at least one contract; a document with no operations publishes nothing.',
            );
        }
        for (const entry of entries) {
            if (entry.kind !== undefined && entry.kind !== WEBHOOK) {
                throw new OpenApiGenerationError(
                    `unknown api kind '${entry.kind}' on '${entry.entry}'`,
                    raw.where,
                    `The only declared kind is "${WEBHOOK}". Leave it out for an ordinary contract.`,
                );
            }
        }
        return entries;
    }

    private errors(raw: JsonReader): ErrorsEntry | undefined {
        const errors = raw.object('errors');
        if (errors === undefined) {
            return undefined;
        }
        return new ErrorsEntry(
            errors.string('entry'),
            errors.string('type'),
            errors
                .objects('responses')
                .map(
                    (response: JsonReader) =>
                        new ErrorResponseEntry(
                            response.string('status'),
                            response.string('description'),
                            response.optionalBoolean('requiresAuth') ?? false,
                        ),
                ),
        );
    }

    private responseHeaders(raw: JsonReader): readonly ResponseHeaderEntry[] {
        return raw.objects('responseHeaders').map((header: JsonReader) => {
            // RETIRED (#1249): a header NAME is never a string constant any more — it is read off the
            // ContextKey that is the one definition of the header. Refused, never accepted beside the
            // new key: two spellings means the old one is never migrated.
            if (header.has(RETIRED_NAME_CONSTANT)) {
                throw new OpenApiGenerationError(
                    `'${RETIRED_NAME_CONSTANT}' was removed from responseHeaders[]; it moved to 'contextKey'`,
                    raw.where,
                    `Replace "${RETIRED_NAME_CONSTANT}" with "contextKey" naming an exported ContextKey in ` +
                        '"entry" (e.g. `export const REQUEST_ID_KEY = WebpiecesCoreHeaders.REQUEST_ID;`, ' +
                        'or a dotted path like "OneTabletKey.TX_ID"); the header name is read off its responseHeader.',
                );
            }
            return new ResponseHeaderEntry(
                header.string('entry'),
                header.string('contextKey'),
                header.optionalString('description'),
                header.optionalBoolean('required'),
            );
        });
    }

    /** A manifest-relative path, resolved against the manifest's own directory. */
    resolve(manifestPath: string, relative: string): string {
        return path.resolve(path.dirname(manifestPath), relative);
    }
}
