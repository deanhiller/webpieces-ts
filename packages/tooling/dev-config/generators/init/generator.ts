import { formatFiles, readNxJson, Tree, updateNxJson, updateJson, addDependenciesToPackageJson } from '@nx/devkit';
import type { InitGeneratorSchema } from './schema';

/**
 * Init generator for @webpieces/dev-config
 *
 * Automatically runs when users execute: nx add @webpieces/dev-config
 *
 * Responsibilities:
 * - Registers the plugin in nx.json
 * - Creates architecture/ directory if needed
 * - Adds madge as a devDependency (required for circular dep checking)
 * - Adds convenient npm scripts to package.json
 * - Provides helpful output about available targets
 */
export default async function initGenerator(tree: Tree, options: InitGeneratorSchema) {
    registerPlugin(tree);
    const installTask = addMadgeDependency(tree);
    createArchitectureDirectory(tree);
    addNpmScripts(tree);

    if (!options.skipFormat) {
        await formatFiles(tree);
    }

    return createSuccessCallback(installTask);
}

function registerPlugin(tree: Tree): void {
    const nxJson = readNxJson(tree);
    if (!nxJson) {
        throw new Error('Could not read nx.json. Are you in an Nx workspace?');
    }

    if (!nxJson.plugins) {
        nxJson.plugins = [];
    }

    const pluginName = '@webpieces/dev-config';
    const alreadyRegistered = nxJson.plugins.some(
        (p) => typeof p === 'string' ? p === pluginName : p.plugin === pluginName
    );

    if (!alreadyRegistered) {
        nxJson.plugins.push(pluginName);
        updateNxJson(tree, nxJson);
        console.log(`✅ Registered ${pluginName} plugin in nx.json`);
    } else {
        console.log(`ℹ️  ${pluginName} plugin is already registered`);
    }
}

function addMadgeDependency(tree: Tree) {
    return addDependenciesToPackageJson(tree, {}, { 'madge': '^8.0.0' });
}

function createArchitectureDirectory(tree: Tree): void {
    if (!tree.exists('architecture')) {
        tree.write('architecture/.gitkeep', '');
        console.log('✅ Created architecture/ directory');
    }
}

function addNpmScripts(tree: Tree): void {
    updateJson(tree, 'package.json', (pkgJson) => {
        pkgJson.scripts = pkgJson.scripts ?? {};

        // Add architecture validation scripts
        pkgJson.scripts['arch:generate'] = 'nx run .:arch:generate';
        pkgJson.scripts['arch:visualize'] = 'nx run .:arch:visualize';
        pkgJson.scripts['arch:validate'] = 'nx run .:arch:validate-no-cycles && nx run .:arch:validate-no-skiplevel-deps';
        pkgJson.scripts['arch:validate-all'] = 'nx run .:arch:validate-no-cycles && nx run .:arch:validate-no-skiplevel-deps && nx run .:arch:validate-architecture-unchanged';

        // Add circular dependency checking scripts
        pkgJson.scripts['arch:check-circular'] = 'nx run-many --target=check-circular-deps --all';
        pkgJson.scripts['arch:check-circular-affected'] = 'nx affected --target=check-circular-deps';

        // Complete validation including circular deps
        pkgJson.scripts['arch:validate-complete'] = 'npm run arch:validate-all && npm run arch:check-circular';

        return pkgJson;
    });

    console.log('✅ Added npm scripts for architecture validation and circular dependency checking');
}

function createSuccessCallback(installTask: ReturnType<typeof addDependenciesToPackageJson>) {
    return async () => {
        await installTask();
        console.log('✅ Added madge to devDependencies');
        console.log('');
        console.log('✅ @webpieces/dev-config plugin initialized!');
        console.log('');
        printAvailableTargets();
    };
}

function printAvailableTargets(): void {
    console.log('📝 Available npm scripts (convenient shortcuts):');
    console.log('');
    console.log('  Architecture graph:');
    console.log('    npm run arch:generate                  # Generate dependency graph');
    console.log('    npm run arch:visualize                 # Visualize dependency graph');
    console.log('');
    console.log('  Validation:');
    console.log('    npm run arch:validate                  # Quick validation (no-cycles + no-skiplevel-deps)');
    console.log('    npm run arch:validate-all              # Full arch validation (+ unchanged check)');
    console.log('    npm run arch:check-circular            # Check all projects for circular deps');
    console.log('    npm run arch:check-circular-affected   # Check affected projects only');
    console.log('    npm run arch:validate-complete         # Complete validation (arch + circular)');
    console.log('');
    console.log('📝 Available Nx targets:');
    console.log('');
    console.log('  Workspace-level architecture validation:');
    console.log('    nx run .:arch:generate                         # Generate dependency graph');
    console.log('    nx run .:arch:visualize                        # Visualize dependency graph');
    console.log('    nx run .:arch:validate-no-cycles               # Check for circular dependencies');
    console.log('    nx run .:arch:validate-no-skiplevel-deps       # Check for redundant dependencies');
    console.log('    nx run .:arch:validate-architecture-unchanged  # Validate against blessed graph');
    console.log('');
    console.log('  Per-project circular dependency checking:');
    console.log('    nx run <project>:check-circular-deps           # Check project for circular deps');
    console.log('    nx affected --target=check-circular-deps       # Check all affected projects');
    console.log('    nx run-many --target=check-circular-deps --all # Check all projects');
    console.log('');
    console.log('💡 Quick start:');
    console.log('   npm run arch:generate           # Generate the graph first');
    console.log('   npm run arch:validate-complete  # Run complete validation');
    console.log('');
}
