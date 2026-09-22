import * as fs from 'node:fs';
import * as path from 'node:path';
import { RenderedSite } from '../render/SitePage';

/**
 * Writes a {@link RenderedSite} to a directory.
 *
 * The directory is created if it is not there, and files are overwritten in place. Nothing is
 * DELETED: a renderer that cleans its output directory is one mistyped `--out` away from removing
 * somebody's source tree, and the cost of the alternative is a stale page nobody links to.
 */
export class SiteWriter {
    /** @returns every absolute path written, in the order it was written. */
    write(outDir: string, site: RenderedSite): readonly string[] {
        const written: string[] = [];
        for (const page of site.pages) {
            written.push(this.writeOne(outDir, page.url, page.html));
        }
        for (const asset of site.assets) {
            written.push(this.writeOne(outDir, asset.url, asset.contents));
        }
        return written;
    }

    private writeOne(outDir: string, url: string, contents: string): string {
        const file = path.join(outDir, ...url.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents, 'utf8');
        return file;
    }
}
