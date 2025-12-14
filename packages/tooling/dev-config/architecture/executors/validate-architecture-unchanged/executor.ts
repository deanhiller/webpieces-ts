/**
 * Validate Architecture Unchanged Executor
 *
 * Validates that the current architecture graph matches the saved blessed graph.
 * This ensures no unapproved architecture changes have been made.
 *
 * Usage:
 * nx run architecture:validate-architecture-unchanged
 */

import type { ExecutorContext } from '@nx/devkit';
import * as fs from 'fs';
import * as path from 'path';
import { generateGraph } from '../../lib/graph-generator';
import { sortGraphTopologically } from '../../lib/graph-sorter';
import { compareGraphs } from '../../lib/graph-comparator';
import { loadBlessedGraph, graphFileExists } from '../../lib/graph-loader';

export interface ValidateArchitectureUnchangedOptions {
    graphPath?: string;
}

export interface ExecutorResult {
    success: boolean;
}

const TMP_DIR = 'tmp/webpieces';
const TMP_MD_FILE = 'webpieces.dependencies.md';

const DEPENDENCIES_DOC_CONTENT = `# Instructions: Architecture Dependency Violation

IN GENERAL, it is better to avoid these changes and find a different way by moving classes
around to existing packages you already depend on. It is not always avoidable though.
A clean dependency graph keeps you out of huge trouble later.

If you are a human, simply run these commands:
* nx run architecture:visualize - to see the new dependencies and validate that change is desired
* nx run architecture:generate - updates the dep graph
* git diff architecture/dependencies.json - to see the deps changes you made

**READ THIS FILE FIRST before making any changes!**

## ⚠️ CRITICAL WARNING ⚠️

**This is a VERY IMPORTANT change that has LARGE REPERCUSSIONS later!**

Adding new dependencies creates technical debt that compounds over time:
- Creates coupling between packages that may be hard to undo
- Can create circular dependency tangles
- Makes packages harder to test in isolation
- Increases build times and bundle sizes
- May force unnecessary upgrades across the codebase

**DO NOT add dependencies without senior developer approval!**

## Understanding the Error

You've attempted to import from a package that is not in your project's allowed dependencies.
The architecture enforces a layered dependency structure where:
- Level 0 packages are foundation packages with NO dependencies on other @webpieces packages
- Higher level packages can only depend on lower level packages
- All dependencies must be explicitly declared

## Steps to Resolve

### Step 1: Generate Current Dependency Graph
Run this command to see the current architecture:
\`\`\`bash
npx nx run architecture:generate
\`\`\`
This creates/updates \`architecture/dependencies.json\` showing all packages and their levels.

### Step 2: Analyze the Proposed Change
Ask yourself:
1. **Is this import truly necessary?** Can you refactor to avoid it?
2. **Should the code move instead?** Maybe the code belongs in a different package.
3. **Will this create a cycle?** Use \`npx nx graph\` to visualize dependencies.
4. **Can you use an interface/abstraction?** Define interface in lower-level package, implement in higher-level.

### Step 3: Get Senior Developer Approval

## 🛑 AI AGENTS: STOP HERE AND ASK FOR HUMAN APPROVAL! 🛑

**YOU MUST NOT PROCEED TO STEP 4 WITHOUT EXPLICIT HUMAN APPROVAL!**

**REQUIRED**: Discuss this architectural change with a senior developer before proceeding.
- Explain why the dependency is needed
- Show you've considered alternatives (Step 2)
- **WAIT for explicit approval before making ANY changes to project.json or package.json**

**AI Agent Instructions:**
1. Present your analysis from Step 2 to the human
2. Explain which package needs which dependency and why
3. ASK: "Do you approve adding this dependency?"
4. **DO NOT modify project.json or package.json until you receive explicit "yes" or approval**

### Step 4: If Approved, Add the Dependency

## ⛔ NEVER MODIFY THESE FILES WITHOUT HUMAN APPROVAL FROM STEP 3! ⛔

Only after receiving explicit human approval in Step 3, make these changes:

1. **Update project.json** - Add to \`build.dependsOn\`:
   \`\`\`json
   {
     "targets": {
       "build": {
         "dependsOn": ["^build", "dep1:build", "NEW_PACKAGE:build"]
       }
     }
   }
   \`\`\`

2. **Update package.json** - Add to \`dependencies\`:
   \`\`\`json
   {
     "dependencies": {
       "@webpieces/NEW_PACKAGE": "*"
     }
   }
   \`\`\`

### Step 5: Update Architecture Definition
Run this command to validate and update the architecture:
\`\`\`bash
npx nx run architecture:generate
\`\`\`

This will:
- Detect any cycles (which MUST be fixed before proceeding)
- Update \`architecture/dependencies.json\` with the new dependency
- Recalculate package levels

### Step 6: Verify No Cycles
\`\`\`bash
npx nx run architecture:validate-no-architecture-cycles
\`\`\`

If cycles are detected, you MUST refactor to break the cycle. Common strategies:
- Move shared code to a lower-level package
- Use dependency inversion (interfaces in low-level, implementations in high-level)
- Restructure package boundaries

## Alternative Solutions (Preferred over adding dependencies)

### Option A: Move the Code
If you need functionality from another package, consider moving that code to a shared lower-level package.

### Option B: Dependency Inversion
Define an interface in the lower-level package, implement it in the higher-level package:
\`\`\`typescript
// In foundation package (level 0)
export interface Logger { log(msg: string): void; }

// In higher-level package
export class ConsoleLogger implements Logger { ... }
\`\`\`

### Option C: Pass Dependencies as Parameters
Instead of importing, receive the dependency as a constructor or method parameter.

## Remember
- Every dependency you add today is technical debt for tomorrow
- The best dependency is the one you don't need
- When in doubt, refactor rather than add dependencies
`;

/**
 * Write the instructions documentation to tmp directory
 */
function writeTmpInstructionsFile(workspaceRoot: string): string {
    const tmpDir = path.join(workspaceRoot, TMP_DIR);
    const mdPath = path.join(tmpDir, TMP_MD_FILE);

    // Ensure tmp directory exists
    fs.mkdirSync(tmpDir, { recursive: true });

    // Write documentation MD file
    fs.writeFileSync(mdPath, DEPENDENCIES_DOC_CONTENT);

    return mdPath;
}

export default async function runExecutor(
    options: ValidateArchitectureUnchangedOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const { graphPath } = options;
    const workspaceRoot = context.root;

    console.log('\n🔍 Validating Architecture Unchanged\n');

    try {
        // Check if saved graph exists
        if (!graphFileExists(workspaceRoot, graphPath)) {
            console.error('❌ No saved graph found at architecture/dependencies.json');
            console.error('');
            console.error('To initialize:');
            console.error('  1. Run: nx run architecture:generate');
            console.error('  2. Run: nx run architecture:visualize');
            console.error('  3. Manually inspect the generated graph to confirm it is the desired architecture');
            console.error('  4. Commit architecture/dependencies.json');
            return { success: false };
        }

        // Step 1: Generate current graph from project.json files
        console.log('📊 Generating current dependency graph...');
        const rawGraph = await generateGraph();

        // Step 2: Topological sort (to get enhanced graph with levels)
        console.log('🔄 Computing topological layers...');
        const currentGraph = sortGraphTopologically(rawGraph);

        // Step 3: Load saved graph
        console.log('📂 Loading saved graph...');
        const savedGraph = loadBlessedGraph(workspaceRoot, graphPath);

        if (!savedGraph) {
            console.error('❌ Could not load saved graph');
            return { success: false };
        }

        // Step 4: Compare graphs
        console.log('🔍 Comparing current graph to saved graph...');
        const comparison = compareGraphs(currentGraph, savedGraph);

        if (comparison.identical) {
            console.log('✅ Architecture unchanged - current graph matches saved graph');
            return { success: true };
        } else {
            // Write instructions file for AI agent
            const mdPath = writeTmpInstructionsFile(workspaceRoot);

            console.error('❌ Architecture has changed since last update!');
            console.error('\nDifferences:');
            console.error(comparison.summary);
            console.error('');
            console.error('⚠️  *** Refer to ' + mdPath + ' for instructions on how to fix *** ⚠️');
            console.error('');
            console.error('To fix:');
            console.error('  1. Review the changes above');
            console.error('  2. If intentional, ASK USER to run: nx run architecture:generate since this is a critical change');
            console.error('  3. Commit the updated architecture/dependencies.json');
            return { success: false };
        }
    } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('❌ Architecture validation failed:', error.message);
        return { success: false };
    }
}
