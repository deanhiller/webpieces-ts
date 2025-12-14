import { formatFiles, readNxJson, Tree, updateNxJson, updateJson, addDependenciesToPackageJson } from '@nx/devkit';
import { createHash } from 'crypto';

export interface InitGeneratorSchema {
    skipFormat?: boolean;
}

function calculateHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
}

function getPackageVersion(tree: Tree): string {
    const content = tree.read('node_modules/@webpieces/dev-config/package.json', 'utf-8');
    if (!content) {
        throw new Error('Could not read package.json from node_modules/@webpieces/dev-config');
    }
    const pkgJson = JSON.parse(content);
    return pkgJson.version;
}

/**
 * Init generator for @webpieces/dev-config
 *
 * Automatically runs when users execute: nx add @webpieces/dev-config
 *
 * Responsibilities:
 * - Registers the plugin in nx.json
 * - Adds architecture validation to targetDefaults (runs once before all builds)
 * - Creates architecture/ directory if needed
 * - Adds madge as a devDependency (required for circular dep checking)
 * - Adds convenient npm scripts to package.json
 * - Always creates eslint.webpieces.config.mjs with @webpieces rules
 * - Creates eslint.config.mjs (if not exists) that imports eslint.webpieces.config.mjs
 * - If eslint.config.mjs exists, shows user how to import eslint.webpieces.config.mjs
 * - Provides helpful output about available targets
 */
export default async function initGenerator(tree: Tree, options: InitGeneratorSchema) {
    registerPlugin(tree);
    addTargetDefaults(tree);
    const installTask = addMadgeDependency(tree);
    createArchitectureDirectory(tree);
    addNpmScripts(tree);
    const hasExistingEslintConfig = createEslintConfig(tree);

    if (!options.skipFormat) {
        await formatFiles(tree);
    }

    return createSuccessCallback(installTask, hasExistingEslintConfig);
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

function addTargetDefaults(tree: Tree): void {
    const nxJson = readNxJson(tree);
    if (!nxJson) {
        throw new Error('Could not read nx.json. Are you in an Nx workspace?');
    }

    if (!nxJson.targetDefaults) {
        nxJson.targetDefaults = {};
    }

    // Find which executors are actually used in this workspace
    const usedExecutors = findUsedExecutors(tree);

    // Only add targetDefaults for executors that are actually used
    let updated = false;

    usedExecutors.forEach((executor) => {
        if (!nxJson.targetDefaults![executor]) {
            nxJson.targetDefaults![executor] = {};
        }

        const targetDef = nxJson.targetDefaults![executor];
        let dependsOn = targetDef.dependsOn || [];

        // Ensure dependsOn is an array
        if (!Array.isArray(dependsOn)) {
            dependsOn = [dependsOn];
        }

        // Check if architecture validation is already in dependsOn
        const hasArchValidation = dependsOn.some((dep) => {
            if (typeof dep === 'string') {
                return dep === 'architecture:validate-complete';
            }
            return dep.target === 'architecture:validate-complete';
        });

        // Check if circular deps validation is already in dependsOn
        const hasCircularDepsValidation = dependsOn.some((dep) => {
            if (typeof dep === 'string') {
                return dep === 'validate-no-file-import-cycles';
            }
            return dep.target === 'validate-no-file-import-cycles';
        });

        if (!hasCircularDepsValidation) {
            // Add circular deps validation (per-project check)
            dependsOn.unshift('validate-no-file-import-cycles');
            targetDef.dependsOn = dependsOn;
            updated = true;
            console.log(`  ✅ Added circular deps validation to ${executor}`);
        }

        if (!hasArchValidation) {
            // Add architecture validation before other dependencies
            dependsOn.unshift('architecture:validate-complete');
            targetDef.dependsOn = dependsOn;
            updated = true;
            console.log(`  ✅ Added architecture validation to ${executor}`);
        }
    });

    if (updated) {
        updateNxJson(tree, nxJson);
        console.log('✅ Added architecture validation to targetDefaults for used executors');
    } else {
        console.log('ℹ️  Architecture validation already configured in targetDefaults');
    }
}

/**
 * Scan all project.json files to find which build executors are actually used
 */
function findUsedExecutors(tree: Tree): Set<string> {
    const usedExecutors = new Set<string>();

    // Known build executors we care about
    const buildExecutors = new Set([
        '@nx/js:tsc',
        '@nx/esbuild:esbuild',
        '@nx/webpack:webpack',
        '@nx/rollup:rollup',
        '@nx/vite:build',
        '@angular/build:application',
        '@angular-devkit/build-angular:browser',
        '@angular-devkit/build-angular:application'
    ]);

    // Scan all project.json files
    tree.listChanges(); // Force tree to be aware of all files

    const scanDir = (dir: string) => {
        for (const child of tree.children(dir)) {
            const childPath = dir === '.' ? child : `${dir}/${child}`;

            if (tree.isFile(childPath)) {
                if (child === 'project.json') {
                    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Intentionally ignoring JSON parse errors for malformed project.json files
                    try {
                        const content = tree.read(childPath, 'utf-8');
                        if (content) {
                            const projectJson = JSON.parse(content);
                            if (projectJson.targets) {
                                for (const target of Object.values(projectJson.targets)) {
                                    const executor = (target as { executor?: string })?.executor;
                                    if (executor && buildExecutors.has(executor)) {
                                        usedExecutors.add(executor);
                                    }
                                }
                            }
                        }
                    } catch (err: any) {
                        //const error = toError(err);
                    }
                }
            } else {
                // Skip node_modules and dist
                if (child !== 'node_modules' && child !== 'dist' && child !== '.git') {
                    scanDir(childPath);
                }
            }
        }
    };

    scanDir('.');

    console.log(`ℹ️  Found ${usedExecutors.size} build executors in use: ${[...usedExecutors].join(', ')}`);

    return usedExecutors;
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
        pkgJson.scripts['arch:generate'] = 'nx run architecture:generate';
        pkgJson.scripts['arch:visualize'] = 'nx run architecture:visualize';
        pkgJson.scripts['arch:validate'] = 'nx run architecture:validate-no-architecture-cycles && nx run architecture:validate-no-skiplevel-deps';
        pkgJson.scripts['arch:validate-all'] = 'nx run architecture:validate-no-architecture-cycles && nx run architecture:validate-no-skiplevel-deps && nx run architecture:validate-architecture-unchanged';

        // Add file import cycle checking scripts
        pkgJson.scripts['arch:check-circular'] = 'nx run-many --target=validate-no-file-import-cycles --all';
        pkgJson.scripts['arch:check-circular-affected'] = 'nx affected --target=validate-no-file-import-cycles';

        // Complete validation including circular deps
        pkgJson.scripts['arch:validate-complete'] = 'npm run arch:validate-all && npm run arch:check-circular';

        return pkgJson;
    });

    console.log('✅ Added npm scripts for architecture validation and circular dependency checking');
}

function createEslintConfig(tree: Tree): boolean {
    const webpiecesConfigPath = 'eslint.webpieces.config.mjs';
    const mainConfigPath = 'eslint.config.mjs';

    // Always create eslint.webpieces.config.mjs with our rules
    createWebpiecesEslintConfig(tree, webpiecesConfigPath);

    // Check if main eslint.config.mjs exists
    const hasExistingConfig = tree.exists(mainConfigPath);

    if (!hasExistingConfig) {
        // No existing config - create one that imports webpieces config
        const mainConfig = `// ESLint configuration
// Imports @webpieces/dev-config rules

import webpiecesConfig from './eslint.webpieces.config.mjs';

// Export the webpieces configuration
// You can add your own rules after spreading webpiecesConfig
export default [
    ...webpiecesConfig,
    // Add your custom ESLint configuration here
];
`;

        tree.write(mainConfigPath, mainConfig);
        console.log('✅ Created eslint.config.mjs with @webpieces/dev-config rules');
    }

    return hasExistingConfig;
}

function getWebpiecesEslintConfigTemplate(tree: Tree): string {
    // Read from canonical template file (single source of truth)
    const templatePath = 'node_modules/@webpieces/dev-config/templates/eslint.webpieces.config.mjs';
    const template = tree.read(templatePath, 'utf-8');

    if (!template) {
        throw new Error(`Could not read ESLint template from ${templatePath}`);
    }

    return template;
}

function warnConfigChanges(tree: Tree, configPath: string, newConfig: string): void {
    const version = getPackageVersion(tree);
    const versionedFilename = `${configPath}.v${version}`;

    tree.write(versionedFilename, newConfig);

    console.log('');
    console.log(`⚠️  ${configPath} has changes`);
    console.log('');
    console.log('   Either you modified the file OR @webpieces/dev-config has updates.');
    console.log('');
    console.log(`   Created: ${versionedFilename} with latest version`);
    console.log('');
    console.log('   Please review and merge if needed:');
    console.log(`     - Your current: ${configPath}`);
    console.log(`     - New version:  ${versionedFilename}`);
    console.log('');
}

function createWebpiecesEslintConfig(tree: Tree, configPath: string): void {
    const webpiecesConfig = getWebpiecesEslintConfigTemplate(tree);

    if (!tree.exists(configPath)) {
        tree.write(configPath, webpiecesConfig);
        console.log(`✅ Created ${configPath}`);
        return;
    }

    const currentContent = tree.read(configPath, 'utf-8');
    if (!currentContent) {
        tree.write(configPath, webpiecesConfig);
        console.log(`✅ Created ${configPath}`);
        return;
    }

    const currentHash = calculateHash(currentContent);
    const newHash = calculateHash(webpiecesConfig);

    if (currentHash === newHash) {
        console.log(`✅ ${configPath} is up to date`);
        return;
    }

    warnConfigChanges(tree, configPath, webpiecesConfig);
}

function createSuccessCallback(
    installTask: ReturnType<typeof addDependenciesToPackageJson>,
    hasExistingEslintConfig: boolean
) {
    return async () => {
        await installTask();

        // ANSI color codes for formatted output
        const GREEN = '\x1b[32m\x1b[1m';
        const BOLD = '\x1b[1m';
        const RESET = '\x1b[0m';

        console.log('');
        console.log('✅ Added madge to devDependencies');
        console.log('');
        console.log(`${GREEN}✅ @webpieces/dev-config plugin initialized!${RESET}`);
        console.log('');
        console.log(`${GREEN}💡 Quick start:${RESET}`);
        console.log(`   ${BOLD}npm run arch:generate${RESET}           # Generate the dependency graph`);
        console.log(`   ${BOLD}npm run arch:validate-complete${RESET}  # Run complete validation`);
        console.log('');
        console.log(`💡 For full documentation, run: ${BOLD}nx run architecture:help${RESET}`);

        // Show ESLint integration instructions if they have an existing config
        if (hasExistingEslintConfig) {
            console.log('');
            console.log('📋 Existing eslint.config.mjs detected');
            console.log('');
            console.log('To use @webpieces/dev-config ESLint rules, add this import to your eslint.config.mjs:');
            console.log('');
            console.log('  import webpiecesConfig from \'./eslint.webpieces.config.mjs\';');
            console.log('');
            console.log('Then spread it into your config array:');
            console.log('');
            console.log('  export default [');
            console.log('    ...webpiecesConfig,  // Add this line');
            console.log('    // ... your existing config');
            console.log('  ];');
        }

        console.log('');
    };
}
