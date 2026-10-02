import * as fs from 'fs';
import * as path from 'path';
import { MANIFEST_FILENAMES, CONFIG_FILENAME } from '@webpieces/rules-config';

// webpieces-disable no-function-outside-class -- existing stateless filesystem predicate shared by both hook products
export function isRootManifest(filePath: string): boolean {
    if (!MANIFEST_FILENAMES.has(path.basename(filePath))) return false;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return fs.existsSync(path.join(path.dirname(filePath), CONFIG_FILENAME));
    } catch (err: unknown) {
        //const error = toError(err); best-effort on a blocking path: unreadable is NOT a root manifest
        return false;
    }
}
