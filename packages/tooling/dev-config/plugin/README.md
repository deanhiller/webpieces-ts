# @webpieces/dev-config Plugin

Nx inference plugin that automatically provides architecture validation and circular dependency checking for your workspace.

## Features

### Workspace-Level Architecture Validation

Automatically adds targets for managing and validating your project architecture:

- **`arch:generate`** - Generate dependency graph from project.json files
- **`arch:visualize`** - Create visual representations of the dependency graph
- **`arch:validate-no-cycles`** - Validate the architecture has no circular dependencies
- **`arch:validate-no-skiplevel-deps`** - Validate no redundant transitive dependencies
- **`arch:validate-architecture-unchanged`** - Validate against blessed dependency graph

### Per-Project Circular Dependency Checking

Automatically adds a `check-circular-deps` target to every project with a `src/` directory using [madge](https://github.com/pahen/madge).

## Installation

Add the plugin to your Nx workspace:

```bash
nx add @webpieces/dev-config
```

This automatically:
- Registers the plugin in `nx.json`
- Adds `madge` as a devDependency (required for circular dependency checking)
- Creates the `architecture/` directory
- Adds convenient npm scripts to `package.json`
- Makes all targets immediately available

## Usage

### Convenient npm Scripts

The init generator adds these npm scripts for easy access:

```bash
# Generate and visualize
npm run arch:generate     # Generate dependency graph
npm run arch:visualize    # Visualize in browser

# Validation
npm run arch:validate                  # Quick: no-cycles + no-skiplevel-deps
npm run arch:validate-all              # Full: adds architecture-unchanged check
npm run arch:check-circular            # Check all projects for circular deps (madge)
npm run arch:check-circular-affected   # Check only affected projects
npm run arch:validate-complete         # Complete: all validations + circular deps

# Recommended workflow
npm run arch:generate           # 1. Generate graph first
npm run arch:validate-complete  # 2. Run all validations
```

### Direct Nx Targets

You can also run targets directly with Nx:

```bash
# Generate the dependency graph
nx run .:arch:generate

# Visualize the graph in your browser
nx run .:arch:visualize

# Validate no circular dependencies
nx run .:arch:validate-no-cycles

# Validate against blessed graph (for CI)
nx run .:arch:validate-architecture-unchanged

# Check for redundant dependencies
nx run .:arch:validate-no-skiplevel-deps
```

### Per-Project Circular Dependency Checking

```bash
# Check a specific project
nx run my-project:check-circular-deps

# Check all affected projects
nx affected --target=check-circular-deps

# Check all projects
nx run-many --target=check-circular-deps --all
```

## Configuration

Configure the plugin in `nx.json`:

```json
{
  "plugins": [
    {
      "plugin": "@webpieces/dev-config",
      "options": {
        "circularDeps": {
          "enabled": true,
          "targetName": "check-circular-deps",
          "excludePatterns": ["**/test-fixtures/**"]
        },
        "workspace": {
          "enabled": true,
          "targetPrefix": "arch:",
          "validations": {
            "noCycles": true,
            "noSkipLevelDeps": true,
            "architectureUnchanged": true
          },
          "features": {
            "generate": true,
            "visualize": true
          }
        }
      }
    }
  ]
}
```

### Configuration Options

#### `circularDeps`

- **`enabled`** (boolean, default: `true`) - Enable/disable circular dependency checking
- **`targetName`** (string, default: `'check-circular-deps'`) - Name of the target to create
- **`excludePatterns`** (string[], default: `[]`) - Patterns to exclude from checking

#### `workspace`

- **`enabled`** (boolean, default: `true`) - Enable/disable workspace-level validation
- **`targetPrefix`** (string, default: `'arch:'`) - Prefix for workspace target names
- **`graphPath`** (string, default: `'architecture/dependencies.json'`) - Path to dependency graph file

##### `workspace.validations`

- **`noCycles`** (boolean, default: `true`) - Enable no-cycles validation
- **`noSkipLevelDeps`** (boolean, default: `true`) - Enable skip-level deps validation
- **`architectureUnchanged`** (boolean, default: `true`) - Enable unchanged graph validation

##### `workspace.features`

- **`generate`** (boolean, default: `true`) - Enable graph generation target
- **`visualize`** (boolean, default: `true`) - Enable visualization target

## Examples

### Disable Architecture Validation, Keep Circular Deps

```json
{
  "plugin": "@webpieces/dev-config",
  "options": {
    "workspace": { "enabled": false }
  }
}
```

### Disable Circular Deps, Keep Architecture Validation

```json
{
  "plugin": "@webpieces/dev-config",
  "options": {
    "circularDeps": { "enabled": false }
  }
}
```

### Disable Specific Validations

```json
{
  "plugin": "@webpieces/dev-config",
  "options": {
    "workspace": {
      "validations": {
        "architectureUnchanged": false,
        "noSkipLevelDeps": false
      }
    }
  }
}
```

### Exclude Test Fixtures from Circular Deps

```json
{
  "plugin": "@webpieces/dev-config",
  "options": {
    "circularDeps": {
      "excludePatterns": ["**/test-fixtures/**", "**/__tests__/**"]
    }
  }
}
```

### Custom Target Names

```json
{
  "plugin": "@webpieces/dev-config",
  "options": {
    "circularDeps": { "targetName": "circular-check" },
    "workspace": { "targetPrefix": "architecture:" }
  }
}
```

## How It Works

The plugin uses Nx's [Project Crystal (Inferred Tasks)](https://nx.dev/concepts/inferred-tasks) feature via the `createNodesV2` API to automatically detect and configure targets:

1. **Workspace Detection**: Looks for a `project.json` at the workspace root to add architecture targets
2. **Project Detection**: Scans all projects for `src/` directories to add circular-deps targets
3. **Pattern Matching**: Respects exclude patterns for fine-grained control

## Requirements

- Nx >= 18.0.0
- Node.js >= 18.0.0
- [Graphviz](https://graphviz.org/) (for visualization)
- [madge](https://github.com/pahen/madge) (bundled, used for circular dep checking)

## Related Documentation

- [Nx Inferred Tasks](https://nx.dev/concepts/inferred-tasks)
- [Architecture Validation Guide](../../architecture/README.md)
- [ESLint Plugin](../eslint-plugin/README.md)
