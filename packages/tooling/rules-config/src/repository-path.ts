import * as fs from 'node:fs';
import * as path from 'node:path';
import { InformAiError } from '@webpieces/tooling-common';
import { toError } from '@webpieces/tooling-common/to-error';

/** Resolve an existing or future repository path through its nearest existing ancestor. */
export class RepositoryPath {
    constructor(private readonly root: string) {}

    resolve(relative: string): string {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- filesystem faults are actionable path repairs at this boundary
        try {
            return this.resolvePath(relative);
        // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        } catch (err: unknown) {
            const error = toError(err);
            if (error instanceof InformAiError) throw error;
            throw new InformAiError(
                `Cannot resolve repository path ${relative}: ${error.message}. Repair its parent directory or dangling symlink.`,
                { cause: error },
            );
        }
    }

    private resolvePath(relative: string): string {
        if (path.isAbsolute(relative))
            throw new InformAiError(`Use a repository-relative path: ${relative}.`);
        const canonicalRoot = fs.realpathSync(this.root);
        const pending: string[] = [];
        let ancestor = path.resolve(this.root, relative);
        while (!fs.lstatSync(ancestor, { throwIfNoEntry: false })) {
            pending.unshift(path.basename(ancestor));
            const parent = path.dirname(ancestor);
            if (parent === ancestor)
                throw new InformAiError(
                    `Cannot resolve repository path ${relative}. Repair its parent directory.`,
                );
            ancestor = parent;
        }
        const resolved = path.resolve(fs.realpathSync(ancestor), ...pending);
        const within = path.relative(canonicalRoot, resolved);
        if (within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
            throw new InformAiError(
                `Path ${relative} resolves outside ${this.root}. Use a file inside this repository and repair any escaping symlink.`,
            );
        }
        return resolved;
    }
}
