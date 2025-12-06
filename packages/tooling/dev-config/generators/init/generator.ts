import { formatFiles, readNxJson, Tree, updateNxJson } from '@nx/devkit';
import type { InitGeneratorSchema } from './schema';

/**
 * Init generator for @webpieces/dev-config
 *
 * Automatically runs when users execute: nx add @webpieces/dev-config
 *
 * Responsibilities:
 * - Registers the plugin in nx.json
 * - Creates architecture/ directory if needed
 * - Provides helpful output about available targets
 */
export default async function initGenerator(tree: Tree, options: InitGeneratorSchema) {
    // 1. Register plugin in nx.json
    const nxJson = readNxJson(tree);
    if (!nxJson) {
        throw new Error('Could not read nx.json. Are you in an Nx workspace?');
    }

    if (!nxJson.plugins) {
        nxJson.plugins = [];
    }

    // Check if already registered
    const pluginName = '@webpieces/dev-config';
    const alreadyRegistered = nxJson.plugins.some(
        (p) => typeof p === 'string'
            ? p === pluginName
            : p.plugin === pluginName
    );

    if (!alreadyRegistered) {
        nxJson.plugins.push(pluginName);
        updateNxJson(tree, nxJson);
        console.log(`✅ Registered ${pluginName} plugin in nx.json`);
    } else {
        console.log(`ℹ️  ${pluginName} plugin is already registered`);
    }

    // 2. Create architecture/ directory if needed
    if (!tree.exists('architecture')) {
        tree.write('architecture/.gitkeep', '');
        console.log('✅ Created architecture/ directory');
    }

    // 3. Format files if not skipped
    if (!options.skipFormat) {
        await formatFiles(tree);
    }

    // 4. Return callback to display helpful message
    return () => {
        console.log('');
        console.log('✅ @webpieces/dev-config plugin initialized!');
        console.log('');
        console.log('📝 Available targets:');
        console.log('');
        console.log('  Workspace-level architecture validation:');
        console.log('    nx run .:arch:generate                      # Generate dependency graph');
        console.log('    nx run .:arch:visualize                     # Visualize dependency graph');
        console.log('    nx run .:arch:validate-no-cycles            # Check for circular dependencies');
        console.log('    nx run .:arch:validate-no-skiplevel-deps    # Check for redundant dependencies');
        console.log('    nx run .:arch:validate-architecture-unchanged # Validate against blessed graph');
        console.log('');
        console.log('  Per-project circular dependency checking:');
        console.log('    nx run <project>:check-circular-deps        # Check project for circular deps');
        console.log('    nx affected --target=check-circular-deps    # Check all affected projects');
        console.log('');
        console.log('💡 First, generate the dependency graph:');
        console.log('   nx run .:arch:generate');
        console.log('');
    };
}
