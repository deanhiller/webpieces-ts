# Versioning Strategy

## Overview

webpieces-ts uses a **build-number based versioning** strategy that combines human-controlled major.minor versions with auto-incrementing patch numbers.

## Format

```
MAJOR.MINOR.BUILD_NUMBER
```

**Example versions:**
- Local development: `0.0.0-dev`
- Build #1234: `0.1.1234`
- Build #5678: `0.1.5678`

## How It Works

### VERSION File

The `VERSION` file at the repository root contains the base version:

```
0.1
```

**Developers control this file:**
- Edit to `0.2` for a **minor version bump** (new features)
- Edit to `1.0` for a **major version bump** (breaking changes)

### Local Development

When developing locally, all packages use the placeholder version:

```json
{
  "version": "0.0.0-dev"
}
```

This makes it clear the packages are in development mode and not production builds.

### CI/CD Builds

When GitHub Actions runs:

1. **Reads** base version from `VERSION` file (e.g., `0.1`)
2. **Appends** GitHub run number (e.g., `1234`)
3. **Creates** full version (e.g., `0.1.1234`)
4. **Updates** all package.json files dynamically
5. **Builds** packages with that version
6. **Publishes** to npm
7. **Tags** git with `v0.1.1234`

## Benefits

✅ **No version conflicts** - Every build gets unique version
✅ **Developers don't forget** - No manual version editing needed
✅ **Clear versioning** - Humans control major.minor, automation handles patch
✅ **Traceable** - Build number maps directly to GitHub Actions run
✅ **No git pollution** - Version changes only happen in CI

## Bumping Versions

### To Release a Minor Version (0.1 → 0.2)

```bash
# 1. Edit VERSION file
echo "0.2" > VERSION

# 2. Commit and push
git add VERSION
git commit -m "chore: bump minor version to 0.2"
git push origin main

# 3. CI automatically publishes as 0.2.BUILD_NUMBER
```

### To Release a Major Version (0.x → 1.0)

```bash
# 1. Edit VERSION file
echo "1.0" > VERSION

# 2. Commit and push
git add VERSION
git commit -m "chore: bump major version to 1.0

BREAKING CHANGE: Major API redesign"
git push origin main

# 3. CI automatically publishes as 1.0.BUILD_NUMBER
```

## Script Details

The `scripts/set-version.sh` script:

1. Reads `VERSION` file for base version
2. Reads `BUILD_NUMBER` environment variable (or uses `dev`)
3. Updates all `package.json` files in:
   - `packages/core/*/package.json`
   - `packages/http/*/package.json`
   - `dist/packages/core/*/package.json` (after build)
   - `dist/packages/http/*/package.json` (after build)
4. Updates all `@webpieces/*` dependencies to match

## Examples

```bash
# Local development (default)
./scripts/set-version.sh
# Result: 0.0.0-dev

# CI build #1234
BUILD_NUMBER=1234 ./scripts/set-version.sh
# Result: 0.1.1234

# Manual test with build 9999
BUILD_NUMBER=9999 ./scripts/set-version.sh
# Result: 0.1.9999
```

## GitHub Actions Integration

The release workflow automatically:

```yaml
- name: Determine version
  run: |
    BASE_VERSION=$(cat VERSION)
    BUILD_NUMBER=${{ github.run_number }}
    FULL_VERSION="${BASE_VERSION}.${BUILD_NUMBER}"

- name: Set dynamic version
  run: BUILD_NUMBER=${{ github.run_number }} ./scripts/set-version.sh

- name: Build and publish
  run: |
    npx nx run-many --target=build --all
    npm publish dist/packages/...
```

## Comparison with Other Strategies

| Strategy | Version Format | Who Controls | webpieces-ts |
|----------|---------------|--------------|--------------|
| **SemVer Manual** | 1.2.3 | Developers edit package.json | ❌ Easy to forget |
| **SemVer Conventional Commits** | 1.2.3 | Commit messages → auto-bump | ❌ Requires discipline |
| **Build Numbers** | 0.1.BUILD | Automation only | ✅ **Our approach!** |
| **CalVer** | 2024.11.3 | Date + counter | ❌ No API meaning |

## Migration Guide

If you need to change the base version:

```bash
# Current: 0.1.1234
# Want: 0.2.x builds

# 1. Edit VERSION file
echo "0.2" > VERSION

# 2. Create PR
git checkout -b chore/bump-minor-version
git add VERSION
git commit -m "chore: bump to 0.2 for new feature cycle"
git push origin chore/bump-minor-version

# 3. Merge PR → next build will be 0.2.XXXX
```

## FAQ

**Q: Why not use semantic-release or conventional commits?**
A: Build numbers are simpler, never conflict, and don't require perfect commit discipline.

**Q: How do I know which build number is which?**
A: The build number is the GitHub Actions run number. View at:
`https://github.com/deanhiller/webpieces-ts/actions/runs/BUILD_NUMBER`

**Q: Can I manually trigger a release with a specific version?**
A: Yes! Use the manual workflow trigger and specify a build number.

**Q: What if two PRs merge quickly?**
A: Each gets a unique GitHub run number, so no conflicts!

**Q: How do local builds work?**
A: Local packages always show `0.0.0-dev` - they're not meant for publishing.
