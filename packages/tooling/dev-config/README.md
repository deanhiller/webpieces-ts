# @webpieces/dev-config

Development configuration, scripts, and patterns for WebPieces projects.

## Overview

This package provides shareable development tools for projects using the WebPieces framework:

- **Nx Plugin** for automatic architecture validation and circular dependency checking
- **Executable scripts** for common development tasks
- **ESLint configuration** with WebPieces patterns and best practices
- **Jest preset** for testing TypeScript projects
- **Base TypeScript configuration** with decorator support
- **Claude Code patterns** for AI-assisted development

## Installation

For Nx workspaces (recommended):

```bash
nx add @webpieces/dev-config
```

For non-Nx projects:

```bash
npm install --save-dev @webpieces/dev-config
```

## Features

### 1. Executable Scripts

All scripts are available as npm bin commands after installation.

#### Available Commands

| Command | Description |
|---------|-------------|
| `wp-start` | Start the WebPieces development server |
| `wp-stop` | Stop the running server |
| `wp-set-version` | Update package versions across the monorepo |
| `wp-use-local` | Switch to local WebPieces packages for development |
| `wp-use-published` | Switch back to published npm packages |
| `wp-setup-patterns` | Create symlinks for Claude Code pattern files |

#### Usage in package.json

```json
{
  "scripts": {
    "start": "wp-start 8080",
    "stop": "wp-stop",
    "dev:local": "wp-use-local",
    "postinstall": "wp-setup-patterns"
  }
}
```

#### Local Development with wp-use-local

To develop against a local copy of webpieces-ts:

1. Set the `WEBPIECES_ROOT` environment variable:
   ```bash
   export WEBPIECES_ROOT=/path/to/webpieces-ts
   ```

2. Build webpieces-ts:
   ```bash
   cd $WEBPIECES_ROOT
   npm run build
   ```

3. Switch to local packages:
   ```bash
   wp-use-local
   ```

4. To switch back to published packages:
   ```bash
   wp-use-published
   ```

### 2. Nx Plugin (Architecture Validation)

Automatically adds architecture validation and circular dependency checking to Nx workspaces.

#### Quick Start

```bash
# Install and register the plugin
nx add @webpieces/dev-config

# Generate dependency graph
nx run architecture:generate

# Validate architecture
nx run architecture:validate-no-cycles

# Check project for circular dependencies
nx run my-project:check-circular-deps
```

#### Available Targets

**Workspace-level:**
- `arch:generate` - Generate dependency graph
- `arch:visualize` - Visualize dependency graph
- `arch:validate-no-cycles` - Validate no circular dependencies
- `arch:validate-no-skiplevel-deps` - Validate no redundant dependencies
- `arch:validate-architecture-unchanged` - Validate against blessed graph

**Per-project:**
- `check-circular-deps` - Check for circular dependencies (auto-added to all projects)

For detailed documentation, see [Plugin README](./plugin/README.md).

### 3. ESLint Configuration

Import the base configuration in your `eslint.config.mjs`:

```javascript
import webpiecesConfig from '@webpieces/dev-config/eslint';
import nx from '@nx/eslint-plugin';

export default [
  ...webpiecesConfig,  // WebPieces base rules
  ...nx.configs['flat/typescript'],
  {
    // Project-specific overrides
    files: ['**/*.ts'],
    rules: {
      // Your custom rules
    }
  }
];
```

The base configuration includes:

- TypeScript-specific rules aligned with WebPieces patterns
- Relaxed rules for test files
- Consistent code quality standards
- Support for decorators and metadata

### 3. Jest Preset

Use the Jest preset in your `jest.config.js`:

```javascript
module.exports = {
  preset: '@webpieces/dev-config/jest',
  // Project-specific overrides
  roots: ['<rootDir>/src'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
  ],
};
```

The preset includes:

- `ts-jest` for TypeScript support
- Decorator and metadata support enabled
- Sensible test file patterns (`*.spec.ts`, `*.test.ts`)
- Coverage configuration

### 4. TypeScript Configuration

Extend the base TypeScript config in your `tsconfig.json`:

```json
{
  "extends": "@webpieces/dev-config/tsconfig",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      // Project-specific path mappings
    }
  },
  "include": ["src/**/*"]
}
```

The base configuration includes:

- Decorator support (`experimentalDecorators`, `emitDecoratorMetadata`)
- Strict type checking
- ES2021 target with CommonJS modules
- Source maps enabled

### 5. Claude Code Patterns

The package includes WebPieces coding patterns and guidelines for Claude Code.

#### Setup

Run the setup command to create symlinks in your `.claude` directory:

```bash
wp-setup-patterns
```

This creates:
- `.claude/CLAUDE.md` - Claude Code guidelines
- `.claude/claude.patterns.md` - Detailed coding patterns

These files will auto-update when you upgrade `@webpieces/dev-config`.

#### Adding to postinstall

Add to your `package.json` to automatically set up patterns after install:

```json
{
  "scripts": {
    "postinstall": "wp-setup-patterns"
  }
}
```

## Auto-Sync Behavior

When you upgrade `@webpieces/dev-config`, all configurations automatically update:

```bash
npm update @webpieces/dev-config
```

Your ESLint, Jest, and TypeScript configurations will use the latest version without manual intervention, as they reference files from `node_modules/@webpieces/dev-config`.

## Version Management

The package follows semantic versioning:

- **Major versions** (2.0.0): Breaking changes to configuration or script behavior
- **Minor versions** (1.1.0): New features, additional scripts, or non-breaking config changes
- **Patch versions** (1.0.1): Bug fixes and documentation updates

## Examples

### Full Project Setup

```bash
# Install the package
npm install --save-dev @webpieces/dev-config

# Set up Claude patterns
npx wp-setup-patterns

# Create eslint.config.mjs
cat > eslint.config.mjs << 'EOF'
import webpiecesConfig from '@webpieces/dev-config/eslint';
export default [...webpiecesConfig];
EOF

# Create jest.config.js
cat > jest.config.js << 'EOF'
module.exports = {
  preset: '@webpieces/dev-config/jest',
};
EOF

# Create tsconfig.json
cat > tsconfig.json << 'EOF'
{
  "extends": "@webpieces/dev-config/tsconfig",
  "include": ["src/**/*"]
}
EOF

# Add scripts to package.json
npm pkg set scripts.start="wp-start 8080"
npm pkg set scripts.stop="wp-stop"
npm pkg set scripts.postinstall="wp-setup-patterns"
```

### Using in webpieces-ts itself

The webpieces-ts monorepo uses its own dev-config package via workspace protocol:

```json
{
  "devDependencies": {
    "@webpieces/dev-config": "workspace:*"
  }
}
```

This ensures webpieces-ts uses the same tools as consuming projects (dogfooding).

## Troubleshooting

### Scripts not found

If bin commands like `wp-start` are not found:

1. Ensure the package is installed: `npm list @webpieces/dev-config`
2. Check that npm created symlinks: `ls -la node_modules/.bin/wp-*`
3. Try reinstalling: `npm install`

### Claude patterns not showing

If `.claude/CLAUDE.md` doesn't exist:

```bash
# Run the setup command manually
npx wp-setup-patterns

# Or check if the files exist in node_modules
ls -la node_modules/@webpieces/dev-config/patterns/
```

### Local development not working

If `wp-use-local` fails:

1. Ensure `WEBPIECES_ROOT` is set: `echo $WEBPIECES_ROOT`
2. Build webpieces-ts: `cd $WEBPIECES_ROOT && npm run build`
3. Check that dist exists: `ls $WEBPIECES_ROOT/dist/packages/`

## Contributing

This package is part of the [webpieces-ts](https://github.com/deanhiller/webpieces-ts) monorepo.

To modify scripts or configurations:

1. Edit files in `packages/tooling/dev-config/`
2. Build: `npx nx build dev-config`
3. Test in webpieces-ts itself (dogfooding)
4. Submit a pull request

## License

Apache-2.0

## Related Packages

- [@webpieces/core-context](https://www.npmjs.com/package/@webpieces/core-context) - Context management
- [@webpieces/http-server](https://www.npmjs.com/package/@webpieces/http-server) - HTTP server
- [@webpieces/http-routing](https://www.npmjs.com/package/@webpieces/http-routing) - Routing and controllers
- [@webpieces/http-filters](https://www.npmjs.com/package/@webpieces/http-filters) - Filter chain

## Support

- GitHub Issues: https://github.com/deanhiller/webpieces-ts/issues
- Documentation: https://github.com/deanhiller/webpieces-ts#readme
