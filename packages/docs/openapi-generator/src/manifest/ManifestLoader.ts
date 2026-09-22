import * as fs from 'node:fs';
import * as path from 'node:path';
import { OpenApiGenerationError } from '../OpenApiGenerationError';
import { JsonReader } from './JsonReader';
import {
    ApiEntry,
    ErrorResponseEntry,
    ErrorsEntry,
    OpenApiManifest,
    ResponseHeaderEntry,
    ServerEntry,
} from './OpenApiManifest';

/** The only `kind` an api entry may declare. Anything else is a typo, and typos are refused. */
const WEBHOOK = 'webhook';

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
    /** @param manifestPath absolute path to `openapi.manifest.json`. */
    load(manifestPath: string): OpenApiManifest {
        if (!fs.existsSync(manifestPath)) {
            throw new OpenApiGenerationError(
                'no manifest at this path',
                manifestPath,
                'Pass --manifest pointing at an openapi.manifest.json that exists.',
            );
        }
        const raw = JsonReader.parseFile(fs.readFileSync(manifestPath, 'utf8'), manifestPath);
        return new OpenApiManifest(
            raw.string('title'),
            raw.string('version'),
            this.servers(raw),
            raw.optionalString('descriptionFile'),
            this.apis(raw),
            raw.strings('securitySchemeNames'),
            this.errors(raw),
            this.responseHeaders(raw),
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
                        ),
                ),
        );
    }

    private responseHeaders(raw: JsonReader): readonly ResponseHeaderEntry[] {
        return raw
            .objects('responseHeaders')
            .map(
                (header: JsonReader) =>
                    new ResponseHeaderEntry(
                        header.string('entry'),
                        header.string('nameConstant'),
                        header.optionalString('description'),
                    ),
            );
    }

    /** A manifest-relative path, resolved against the manifest's own directory. */
    resolve(manifestPath: string, relative: string): string {
        return path.resolve(path.dirname(manifestPath), relative);
    }
}
