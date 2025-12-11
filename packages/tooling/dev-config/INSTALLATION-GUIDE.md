# @webpieces/dev-config Installation Guide

## Installation

```bash
nx add @webpieces/dev-config
```

## What Happens During Installation

The init generator runs automatically and sets up:

### 1. Nx Plugin Registration
- ✅ Registers `@webpieces/dev-config` in `nx.json`
- ✅ Creates workspace-level architecture validation targets
- ✅ Creates per-project circular dependency checking targets

### 2. Dependencies
- ✅ Adds `madge` as a devDependency

### 3. Directory Structure
- ✅ Creates `architecture/` directory for dependency graphs

### 4. npm Scripts
Adds convenient shortcuts to `package.json`:
```json
{
  "scripts": {
    "arch:generate": "nx run architecture:generate",
    "arch:visualize": "nx run architecture:visualize",
    "arch:validate": "...",
    "arch:validate-all": "...",
    "arch:check-circular": "...",
    "arch:check-circular-affected": "...",
    "arch:validate-complete": "..."
  }
}
```

### 5. ESLint Configuration

#### Scenario A: No Existing ESLint Config (New Projects) ✨

**Creates two files:**

1. **`eslint.webpieces.config.mjs`** - Contains all @webpieces ESLint rules
2. **`eslint.config.mjs`** - Imports and uses the webpieces config

```javascript
// eslint.config.mjs (created automatically)
import webpiecesConfig from './eslint.webpieces.config.mjs';

export default [
    ...webpiecesConfig,
    // Add your custom ESLint configuration here
];
```

**Result:** ✅ **Zero configuration needed!** ESLint with @webpieces rules works immediately.

---

#### Scenario B: Existing ESLint Config (Existing Projects) 📋

**Creates one file:**

1. **`eslint.webpieces.config.mjs`** - Contains all @webpieces ESLint rules

**Displays this message:**

```
📋 Existing eslint.config.mjs detected

To use @webpieces/dev-config ESLint rules, add this import to your eslint.config.mjs:

  import webpiecesConfig from './eslint.webpieces.config.mjs';

Then spread it into your config array:

  export default [
    ...webpiecesConfig,  // Add this line
    // ... your existing config
  ];
```

**What you need to do:**

Just add one line to your existing `eslint.config.mjs`:

```javascript
// Your existing eslint.config.mjs
import webpiecesConfig from './eslint.webpieces.config.mjs';  // Add this
import yourExistingConfig from './your-config.mjs';

export default [
    ...webpiecesConfig,  // Add this
    ...yourExistingConfig,
    // ... rest of your config
];
```

**Result:** ✅ **One line to add!** ESLint with @webpieces rules integrated with your existing setup.

---

## ESLint Rules Included

The `eslint.webpieces.config.mjs` file includes:

### @webpieces Custom Rules
- **`@webpieces/catch-error-pattern`** - Enforces proper error handling patterns
- **`@webpieces/no-unmanaged-exceptions`** - Ensures exceptions are properly managed
- **`@webpieces/max-method-lines`** - Limits method length to 70 lines
- **`@webpieces/max-file-lines`** - Limits file length to 700 lines
- **`@webpieces/enforce-architecture`** - Validates architectural boundaries

### TypeScript & General Rules
- Configures TypeScript parser
- Sets up reasonable defaults for TypeScript projects
- Relaxed rules for test files

## Customizing Rules

### Option 1: Modify `eslint.webpieces.config.mjs` directly

```javascript
// eslint.webpieces.config.mjs
export default [
    // ... ignores, plugins, languageOptions ...
    {
        rules: {
            '@webpieces/max-method-lines': ['error', { max: 100 }], // Change from 70 to 100
            '@webpieces/catch-error-pattern': 'off',  // Disable this rule
            // ... other rules
        },
    },
];
```

### Option 2: Override in your main `eslint.config.mjs`

```javascript
// eslint.config.mjs
import webpiecesConfig from './eslint.webpieces.config.mjs';

export default [
    ...webpiecesConfig,
    {
        // Override specific rules
        files: ['**/*.ts'],
        rules: {
            '@webpieces/max-method-lines': ['error', { max: 100 }],
        },
    },
];
```

### Option 3: Remove rules you don't want

If you don't want certain rules at all, just delete or comment them out in `eslint.webpieces.config.mjs`.

## Architecture Validation Usage

After installation, all these commands work immediately:

```bash
# Generate dependency graph
npm run arch:generate

# Visualize in browser
npm run arch:visualize

# Run all validations
npm run arch:validate-complete

# Check circular dependencies
npm run arch:check-circular

# Check only affected projects
npm run arch:check-circular-affected
```

## Nx Targets Available

All these targets are automatically created:

### Workspace-level (run with `nx run architecture:target`)
- `arch:generate`
- `arch:visualize`
- `arch:validate-no-cycles`
- `arch:validate-no-skiplevel-deps`
- `arch:validate-architecture-unchanged`

### Per-project (run with `nx run <project>:target`)
- `check-circular-deps` - Available for every project with a `src/` directory

## Verification

Test that everything works:

```bash
# Test ESLint rules
npx eslint .

# Test architecture validation
npm run arch:validate-complete

# Test circular dependency checking
npm run arch:check-circular
```

## Uninstalling

If you want to remove @webpieces rules:

1. Delete `eslint.webpieces.config.mjs`
2. Remove the import from `eslint.config.mjs`
3. Remove `@webpieces/dev-config` from `nx.json` plugins
4. Remove the npm scripts from `package.json`

The `architecture/` directory and generated graphs can be kept or deleted as needed.
