import * as fs from 'node:fs';
import * as path from 'node:path';
import { DocsManifest, ProsePage, ProsePageEntry } from './DocsManifest';
import { DocsSiteError } from '../DocsSiteError';
import { JsonNode } from '../spec/JsonNode';
import { Slug } from '../spec/Slug';

/** The one filename this package looks for inside a prose directory. */
export const MANIFEST_FILE = 'docs.manifest.json';

/**
 * Loads `docs.manifest.json` and the markdown it names.
 *
 * A page the manifest names but the directory does not hold is a HARD FAILURE, not a skipped entry.
 * Skipping it would publish a site whose navigation silently lost a page somebody wrote, and the
 * only way anybody notices is a partner asking where the guide went.
 *
 * A markdown file the manifest does NOT name is simply not published: the manifest is the published
 * list, so adding a file to the directory is not the same act as publishing it.
 */
export class ProseLoader {
    /** @param directory the `--prose` directory, or `undefined` when the run has no prose at all. */
    load(directory: string | undefined): readonly ProsePage[] {
        if (directory === undefined) {
            return [];
        }
        return this.pagesOf(directory, this.manifestOf(directory));
    }

    /** The manifest's own `title`, or the empty string when there is no manifest. */
    titleOf(directory: string | undefined): string {
        if (directory === undefined) {
            return '';
        }
        return this.manifestOf(directory).title;
    }

    private manifestOf(directory: string): DocsManifest {
        const file = path.join(directory, MANIFEST_FILE);
        const root = new JsonNode(this.parse(file, this.read(file)));
        const pages: ProsePageEntry[] = [];
        for (const entry of root.list('pages')) {
            const name = entry.text('file');
            if (name === undefined) {
                throw new DocsSiteError(
                    `a ${MANIFEST_FILE} page entry has no "file"`,
                    file,
                    'Give every entry of "pages" a "file" naming a markdown file in this directory.',
                );
            }
            pages.push(new ProsePageEntry(name, entry.text('title') ?? name));
        }
        return new DocsManifest(root.text('title') ?? '', pages);
    }

    private pagesOf(directory: string, manifest: DocsManifest): readonly ProsePage[] {
        const slugs = new Slug();
        return manifest.pages.map((entry: ProsePageEntry): ProsePage => {
            const file = path.join(directory, entry.file);
            if (!fs.existsSync(file)) {
                throw new DocsSiteError(
                    `${MANIFEST_FILE} names a page that is not there: ${entry.file}`,
                    file,
                    `Add ${entry.file} to ${directory}, or remove it from "pages" in ${MANIFEST_FILE}.`,
                );
            }
            return new ProsePage(entry.title, slugs.unique(entry.title), this.read(file));
        });
    }

    private read(file: string): string {
        if (!fs.existsSync(file)) {
            throw new DocsSiteError(
                `no ${path.basename(file)} there`,
                file,
                `Point --prose at a directory holding ${MANIFEST_FILE}, or leave --prose off to publish the reference alone.`,
            );
        }
        return fs.readFileSync(file, 'utf8');
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
                `${MANIFEST_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
                file,
                'Fix the JSON syntax and re-run.',
            );
        }
    }
}
