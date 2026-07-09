#!/usr/bin/env bash
#
# Publish every @webpieces package to npm, in dependency order.
#
# WHY THIS EXISTS
# ---------------
# The publish list used to live inline in .github/workflows/release.yml as a wall of
# `npm publish dist/...` lines. It was hand-maintained, so it drifted: PR #332 split
# `http-client` into three packages and deleted the original, and every Release run after that
# died with
#
#     npm error enoent Could not read package.json: .../dist/packages/http/http-client/package.json
#
# npm publish aborts the whole step on the first bad path, so the tooling packages at the end of
# the list never published. @webpieces/nx-webpieces-rules sat at 0.3.313 for days while the repo
# thought it was releasing.
#
# The fix is not "update the list" — it is "make a stale list impossible". PREFLIGHT below
# cross-checks the ordered list against the workspace and fails BEFORE publishing anything:
#
#   - a publishable package missing from ORDER (and not in SKIP)  -> fail, name it
#   - an ORDER entry with no built dist/<dir>/package.json         -> fail, name it
#
# Add a package and forget this file, and the release stops with a message telling you what to do,
# instead of half-publishing and leaving npm inconsistent with the tag.

set -euo pipefail

# CI publishes with npm trusted publishing (OIDC), which requires --provenance. A LOCAL publish has
# no OIDC identity, so `npm publish --provenance` fails. Override for a manual release:
#
#     npm login
#     BUILD_NUMBER=900 ./scripts/set-version.sh
#     pnpm nx run-many --target=build --all
#     PUBLISH_FLAGS="--access public" ./scripts/publish-packages.sh
#     git checkout -- packages/*/*/package.json     # undo the version stamp
#
# Pick a BUILD_NUMBER that CI's github.run_number will not reach soon: CI publishes
# 0.3.<run_number>, and republishing an existing version 403s and aborts the release.
PUBLISH_FLAGS="${PUBLISH_FLAGS:---access public --provenance}"

# Dependency order. A package must appear AFTER everything it depends on: npm has no ordering
# guarantee, and a consumer resolving a not-yet-published version fails.
ORDER=(
    packages/core/core-context
    packages/core/core-util
    packages/cloud/gcp-identity
    # Logging backends depend only on core-util.
    packages/logging/winston
    packages/logging/bunyan
    packages/http/http-routing
    # http-client-core is browser+node and depends only on core-util; its two environment
    # packages depend on it (and http-client-node also on gcp-identity + core-context).
    packages/http/http-client-core
    packages/http/http-client-browser
    packages/http/http-client-node
    packages/cloud/cloudtasks-client
    packages/http/http-server
    packages/tooling/rules-config
    packages/tooling/pr-gate
    packages/tooling/eslint-rules
    packages/tooling/ai-hook-rules
    packages/tooling/code-rules
    packages/tooling/nx-webpieces-rules
)

# Publishable in package.json, but deliberately never released. Each needs a reason.
SKIP=(
    # A test/mock helper, not a released package. The npm token cannot create it, and the 404
    # aborted the whole release before the tooling packages below could publish.
    packages/core/core-mock
)

contains() {
    local needle="$1"; shift
    local item
    for item in "$@"; do [ "$item" = "$needle" ] && return 0; done
    return 1
}

echo "🔎 Preflight: reconciling the publish list against the workspace"

failed=0

# 1. Every publishable package in the workspace must be accounted for.
while IFS= read -r pkg_json; do
    dir="$(dirname "$pkg_json")"
    access="$(node -p "require('./$pkg_json').publishConfig?.access ?? ''")"
    [ "$access" = "public" ] || continue

    if ! contains "$dir" "${ORDER[@]}" && ! contains "$dir" "${SKIP[@]}"; then
        name="$(node -p "require('./$pkg_json').name")"
        echo "  ❌ $name ($dir) is publishable but is in neither ORDER nor SKIP in $0"
        failed=1
    fi
done < <(find packages -mindepth 3 -maxdepth 3 -name package.json | sort)

# 2. Every ordered entry must have actually been built.
for dir in "${ORDER[@]}"; do
    if [ ! -f "dist/$dir/package.json" ]; then
        echo "  ❌ dist/$dir/package.json is missing — was it deleted, renamed, or not built?"
        failed=1
    fi
done

if [ "$failed" -ne 0 ]; then
    echo ""
    echo "Refusing to publish. Fix ORDER/SKIP in $0 so npm and the git tag cannot disagree."
    exit 1
fi

echo "✅ Preflight passed: ${#ORDER[@]} package(s) to publish, ${#SKIP[@]} skipped"
echo ""

for dir in "${ORDER[@]}"; do
    echo "📦 npm publish dist/$dir $PUBLISH_FLAGS"
    # shellcheck disable=SC2086 -- PUBLISH_FLAGS is an intentional word-split flag list
    npm publish "dist/$dir" $PUBLISH_FLAGS
done

echo ""
echo "✅ Published ${#ORDER[@]} package(s)"
