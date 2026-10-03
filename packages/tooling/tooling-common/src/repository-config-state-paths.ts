import * as fs from 'node:fs';
import * as path from 'node:path';
import { toError } from './to-error';

/** Repository declarations identify checked-in policy inputs, which are never relocatable tool state. */
export class RepositoryConfigStatePaths {
    keepInPlace(root: string): readonly string[] {
        const filename = path.join(root, 'webpieces.config.json');
        if (!fs.existsSync(filename)) return [];
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- uncertain declarations defer state migration so config repairs cannot lose their inputs
        try {
            // webpieces-disable no-any-unknown -- transport metadata only; the config loader owns complete schema validation
            const document: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
            if (!document || typeof document !== 'object') return this.everyEntry(root);
            if (!('rulePacks' in document)) return [];
            if (!Array.isArray(document.rulePacks)) return this.everyEntry(root);
            const kept = new Set<string>(['rules.lock.json', 'instruct-ai']);
            for (const declaration of document.rulePacks) {
                if (!declaration || typeof declaration !== 'object' || typeof declaration.config !== 'string') return this.everyEntry(root);
                const relative = path.relative(path.join(root, '.webpieces'), path.resolve(root, declaration.config));
                if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
                    kept.add(relative.split(path.sep)[0]);
                }
            }
            return [...kept];
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return this.everyEntry(root);
        }
    }

    private everyEntry(root: string): readonly string[] {
        const directory = path.join(root, '.webpieces');
        return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
    }
}
