import * as fs from 'node:fs';
import * as path from 'node:path';
import { injectable, bindingScopeValues } from 'inversify';
import { RulePackDeclaration } from '@webpieces/rules-sdk';
import { InformAiError } from '@webpieces/tooling-common';
import { toError } from '@webpieces/tooling-common/to-error';
import { NodeRulePackModuleLoader, RulePackDiscovery, RulePackRegistry } from './rule-pack-registry';

/** Client-owned package declarations are the only source of pack selection. */
@injectable(bindingScopeValues.Singleton)
export class RulePackSelection {
    loadFrom(clientRoot: string): RulePackRegistry {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return this.loadDeclaredFrom(clientRoot);
        } catch (err: unknown) {
            const error = toError(err);
            if (error instanceof InformAiError) throw error;
            throw new InformAiError(`Cannot load declared rule packs from ${path.join(clientRoot, 'package.json')}: ${error.message}. Install their declared package versions and repair the module declarations.`);
        }
    }

    private loadDeclaredFrom(clientRoot: string): RulePackRegistry {
        const manifestPath = path.join(clientRoot, 'package.json');
        if (!fs.existsSync(manifestPath)) {
            throw new InformAiError(`Missing ${manifestPath}. Declare webpieces.rulePacks in the client package.json before loading policy config.`);
        }
        // webpieces-disable no-any-unknown -- external JSON is narrowed before use
        const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        const webpieces = pkg['webpieces'];
        if (!webpieces || typeof webpieces !== 'object' || !('rulePacks' in webpieces) || !Array.isArray(webpieces.rulePacks)) {
            throw new InformAiError('Missing webpieces.rulePacks in package.json. Declare each selected pack using its public rule-pack module; there is no built-in pack fallback.');
        }
        const declarations: RulePackDeclaration[] = webpieces.rulePacks.map(entry => {
            if (!entry || typeof entry !== 'object' || typeof entry.module !== 'string' || !entry.module) {
                throw new InformAiError('Invalid webpieces.rulePacks entry. Supply {"module":"<package>/rule-pack"}.');
            }
            return new RulePackDeclaration(entry.module);
        });
        return new RulePackDiscovery(new NodeRulePackModuleLoader(clientRoot)).discover(declarations);
    }
}
