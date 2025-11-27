# Contributing to WebPieces-TS

Thank you for your interest in contributing to WebPieces-TS!

## Development Workflow

### 1. Fork and Clone

```bash
# Fork the repository on GitHub, then:
git clone https://github.com/YOUR_USERNAME/webpieces-ts.git
cd webpieces-ts
npm install
```

### 2. Create a Feature Branch

```bash
git checkout -b feat/your-feature-name
# or
git checkout -b fix/bug-description
```

### 3. Make Your Changes

- Write code following existing patterns
- Add tests for new functionality
- Ensure all tests pass: `npm test`
- Build packages: `npx nx run-many --target=build --all`

### 4. Commit Your Changes

We follow [Conventional Commits](https://www.conventionalcommits.org/) for automatic versioning:

```bash
# For new features (bumps minor version)
git commit -m "feat: add new filter for authentication"

# For bug fixes (bumps patch version)
git commit -m "fix: resolve memory leak in context manager"

# For breaking changes (bumps major version)
git commit -m "feat!: redesign routing API

BREAKING CHANGE: routing configuration now requires explicit paths"
```

**Commit types:**
- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation only
- `test:` - Adding tests
- `refactor:` - Code refactoring
- `perf:` - Performance improvement
- `chore:` - Build process or auxiliary tool changes

### 5. Push and Create Pull Request

```bash
git push origin feat/your-feature-name
```

Then create a Pull Request on GitHub.

## Pull Request Process

1. **CI must pass** - All tests and builds must succeed
2. **Code review required** - At least one approval needed
3. **Branch must be up to date** - Rebase if needed
4. **No direct pushes to main** - All changes via PRs

### PR Checklist

- [ ] Tests pass locally (`npm test`)
- [ ] Builds succeed (`npx nx run-many --target=build --all`)
- [ ] Commit messages follow conventional commits
- [ ] Changes are documented (if needed)
- [ ] PR description explains what and why

## What Happens After Merge

When your PR is merged to `main`:

1. **Automatic versioning** - Based on commit messages
2. **Automatic publishing** - Packages published to npm
3. **Git tag created** - Version tag added
4. **GitHub release created** - With changelog

## Project Structure

```
webpieces-ts/
├── packages/
│   ├── core/
│   │   ├── core-context/    # AsyncLocalStorage context
│   │   └── core-meta/       # Metadata interfaces
│   └── http/
│       ├── http-api/        # HTTP decorators
│       ├── http-filters/    # Filter chain
│       ├── http-routing/    # Route registration
│       ├── http-client/     # HTTP client
│       └── http-server/     # Server bootstrap
├── apps/
│   └── example-app/         # Example usage
└── dist/                    # Build output (gitignored)
```

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run tests for specific package
npx nx test core-context
```

## Building Packages

```bash
# Build all packages
npx nx run-many --target=build --all

# Build specific package
npx nx build core-context

# Clean build artifacts
npm run clean
```

## Code Style

- Use TypeScript strict mode
- Follow existing code patterns
- Use meaningful variable names
- Add JSDoc comments for public APIs
- Keep functions small and focused

## Questions?

- Open an issue for bugs or feature requests
- Start a discussion for questions
- Check existing issues before creating new ones

## License

By contributing, you agree that your contributions will be licensed under the Apache-2.0 License.
