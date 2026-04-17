import { loadConfig } from '@webpieces/rules-config';
import { toValidateCodeOptions } from './from-shared-config';
import runValidateCode from './validate-code';

async function main(): Promise<void> {
    const workspaceRoot = process.cwd();
    const shared = loadConfig(workspaceRoot);
    if (!shared.configPath) {
        console.error('No webpieces.config.json found');
        process.exit(1);
    }
    const options = toValidateCodeOptions(shared);
    const result = await runValidateCode(options, workspaceRoot);
    process.exit(result.success ? 0 : 1);
}

main();
