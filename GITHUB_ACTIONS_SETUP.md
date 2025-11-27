# GitHub Actions Setup Guide

This document explains how to set up automated CI/CD for the webpieces-ts monorepo.

## What We've Built

### 1. CI Workflow (`.github/workflows/ci.yml`)
**Triggers:** Every PR and push to main
**What it does:**
- Runs tests on Node 18, 20, and 22
- Builds all 7 packages
- Uploads code coverage
- **Blocks PRs if tests fail**

### 2. Release Workflow (`.github/workflows/release.yml`)
**Triggers:** When code is merged to main (or manual workflow dispatch)
**What it does:**
- Auto-detects version bump from commit messages
- Versions all packages
- Publishes to npm with OIDC (no tokens!)
- Creates git tags
- Creates GitHub releases
- **Skips if no package changes**

---

## Setup Steps (Do This Now!)

### Step 1: Set up npm Trusted Publishing

1. **Go to npmjs.com** and log in
2. **For EACH of your 7 packages**, go to the package settings:
   - Since packages don't exist yet, you'll need to publish them ONCE manually first (see "First Manual Publish" below)
   - Or, you can configure trusted publishing after the first GitHub Actions publish

3. **After packages exist**, configure trusted publishing:
   - Go to: `https://www.npmjs.com/package/@webpieces/PACKAGE_NAME/access`
   - Click "Publishing Access" → "Trusted Publishers"
   - Click "Add Trusted Publisher"
   - Select **"GitHub Actions"**
   - Fill in:
     - **Repository Owner:** `deanhiller`
     - **Repository Name:** `webpieces-ts`
     - **Workflow File:** `release.yml`
     - **Environment (optional):** leave blank
   - Click "Add"
   - Repeat for all 7 packages

### Step 2: Set up Branch Protection Rules

1. **Go to GitHub:** https://github.com/deanhiller/webpieces-ts/settings/branches
2. **Click "Add branch protection rule"**
3. **Configure:**
   - **Branch name pattern:** `main`
   - ✅ **Require a pull request before merging**
     - ✅ Require approvals: 1
   - ✅ **Require status checks to pass before merging**
     - ✅ Require branches to be up to date
     - Search and add: `build-and-test (20.x)`
   - ✅ **Do not allow bypassing the above settings**
   - ✅ **Restrict who can push to matching branches**
     - Leave empty (blocks everyone except actions/admins)
4. **Click "Create"**

### Step 3: First Manual Publish (One-Time Setup)

Since npm trusted publishing requires packages to exist first, you need to publish once manually:

**Option A: Use Automation Token (Easier for now)**
1. Create automation token on npmjs.com with "Bypass 2FA"
2. Run: `npm config set //registry.npmjs.org/:_authToken=YOUR_TOKEN`
3. Run: `npx nx release --first-release 0.1.0 --yes`

**Option B: Use OTP with Authenticator**
1. Set up Google Authenticator on npmjs.com
2. Run: `npx nx release --first-release 0.1.0 --yes --otp=CODE`

After this one-time publish, GitHub Actions will handle everything!

---

## How the Workflow Works

### Development Flow:

```
1. Create feature branch
   └─> git checkout -b feat/my-feature

2. Make changes, commit
   └─> git commit -m "feat: add new feature"

3. Push and create PR
   └─> git push origin feat/my-feature
   └─> GitHub: Create Pull Request

4. CI runs automatically
   └─> Tests + Builds on PR
   └─> Must pass before merge

5. Get approval & merge PR
   └─> Requires 1 approval
   └─> CI must be green

6. Release workflow triggers
   └─> Auto-publishes to npm
   └─> Creates git tag
   └─> Creates GitHub release
```

### Commit Message Convention

The release workflow auto-detects version bumps from commit messages:

- `feat: description` → **Minor version** (0.1.0 → 0.2.0)
- `fix: description` → **Patch version** (0.1.0 → 0.1.1)
- `BREAKING CHANGE:` or `feat!:` → **Major version** (0.1.0 → 1.0.0)

**Examples:**
```bash
git commit -m "feat: add new HTTP client method"  # bumps minor
git commit -m "fix: resolve context leak in filters"  # bumps patch
git commit -m "feat!: redesign routing API"  # bumps major
```

---

## Manual Release Trigger

You can also trigger releases manually:

1. Go to: https://github.com/deanhiller/webpieces-ts/actions/workflows/release.yml
2. Click "Run workflow"
3. Select version bump type
4. Click "Run workflow"

---

## Branch Protection Features

With the protection rules in place:

❌ **Cannot** push directly to main
❌ **Cannot** merge failing PRs
❌ **Cannot** merge without approval
❌ **Cannot** bypass checks (even repo admins)
✅ **Can** push to main from GitHub Actions
✅ **Can** emergency bypass (if you disable protection temporarily)

---

## Troubleshooting

### "Publishing failed - EOTP error"

**Cause:** Trusted publishing not configured or npm token being used instead.

**Fix:**
1. Ensure packages exist on npm
2. Configure trusted publishing for each package
3. Remove any `NPM_TOKEN` secrets if present

### "CI check failed"

**Cause:** Tests or builds are failing.

**Fix:**
1. Run tests locally: `npm test`
2. Run builds locally: `npx nx run-many --target=build --all`
3. Fix issues and push again

### "No changes detected"

**Cause:** No changes in `packages/` since last release.

**Fix:** This is expected behavior. Make changes to packages and push.

---

## Security Notes

- ✅ No long-lived tokens stored in GitHub Secrets
- ✅ OIDC provides short-lived, workflow-specific credentials
- ✅ Provenance attestations added automatically
- ✅ Branch protection prevents unauthorized publishes
- ✅ All publishes are auditable in GitHub Actions logs

---

## Next Steps

After setup:

1. **Test the workflow:**
   - Create a test PR with a small change
   - Verify CI runs
   - Merge and watch release workflow

2. **Invite collaborators:**
   - GitHub Settings → Collaborators
   - They can create PRs but need approval to merge

3. **Optional enhancements:**
   - Add code linting to CI
   - Add dependency scanning
   - Set up automated changelog generation
