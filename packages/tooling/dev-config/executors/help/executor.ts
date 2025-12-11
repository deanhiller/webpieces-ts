import type { ExecutorContext } from '@nx/devkit';

export interface HelpExecutorOptions {}

export default async function helpExecutor(
    options: HelpExecutorOptions,
    context: ExecutorContext
): Promise<{ success: true }> {
    // ANSI color codes
    const GREEN = '\x1b[32m\x1b[1m';
    const BOLD = '\x1b[1m';
    const RESET = '\x1b[0m';

    console.log('');
    console.log(`${GREEN}💡 @webpieces/dev-config - Available Commands${RESET}`);
    console.log('');
    console.log(`${BOLD}📝 Available npm scripts (convenient shortcuts):${RESET}`);
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
    console.log(`${BOLD}📝 Available Nx targets:${RESET}`);
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
    console.log(`${GREEN}💡 Quick start:${RESET}`);
    console.log(`   ${BOLD}npm run arch:generate${RESET}           # Generate the graph first`);
    console.log(`   ${BOLD}npm run arch:validate-complete${RESET}  # Run complete validation`);
    console.log('');

    return { success: true };
}
