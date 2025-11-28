# GitHub Actions Workflows

This directory contains automated workflows for the webpieces-ts repository.

## Workflows

### ci.yml
Runs on every PR and push to main:
- Tests on Node 18, 20, 22
- Builds all packages
- Uploads code coverage

### release.yml
Publishes packages to npm when code is merged to main:
- Reads VERSION file (e.g., 0.2)
- Appends GitHub run number (e.g., 1234)
- Creates version 0.2.1234
- Publishes all 7 packages to npm
- Creates git tag

### auto-approve.yml
Auto-approves and enables auto-merge for PRs from @deanhiller:
- Approves using webpieces-bot account
- Enables auto-merge
- Only for repo owner PRs
- Other contributors require manual approval
