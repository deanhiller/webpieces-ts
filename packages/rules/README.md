# @webpieces/rules

Umbrella package for WebPieces development configuration and rules. This package installs all necessary development tooling.

## Installation

```bash
npm install --save-dev @webpieces/rules
```

## What's Included

This package installs:

- `@webpieces/dev-config` - ESLint rules, TypeScript config, Jest presets, and CLI scripts

## Usage

Access configurations from dev-config:

```javascript
// eslint.config.js
import wpEslint from '@webpieces/dev-config/eslint';
export default wpEslint;
```

```json
// tsconfig.json
{
  "extends": "@webpieces/dev-config/tsconfig"
}
```

```javascript
// jest.config.js
module.exports = {
  preset: '@webpieces/dev-config/jest'
};
```

## CLI Scripts

After installation, you'll have access to WebPieces CLI commands:

```bash
wp-start          # Start the development server
wp-stop           # Stop the development server
wp-set-version    # Set version for all packages
wp-use-local      # Switch to local WebPieces packages
wp-use-published  # Switch to published WebPieces packages
```

## Version Compatibility

All @webpieces packages use lock-step versioning. Always use matching versions:

```json
{
  "devDependencies": {
    "@webpieces/rules": "0.2.10"
  }
}
```

## License

Apache-2.0
