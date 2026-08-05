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
    # A test/mock helper with no @webpieces deps. It was in SKIP for a long time because npm
    # trusted publishing (OIDC + --provenance) cannot CREATE a brand-new scoped package — only
    # publish to a name that already exists — so the first-ever publish 404'd and aborted the
    # whole release. Once the name was bootstrapped on npm by an authenticated manual publish,
    # CI can keep it in sync like every other package. Consumers (e.g. trytami) were cloning it
    # by hand while it was unpublished; see issue #429's sibling report.
    packages/core/core-mock
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

    if ! contains "$dir" "${ORDER[@]}" && ! contains "$dir" "${SKIP[@]+"${SKIP[@]}"}"; then
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

# 3. HOIST publishConfig.bin -> bin, in the DIST manifest only.
#
# THE BUG THIS FIXES (0.4.575 shipped with NO bins at all — every wp-* command gone).
# Source manifests deliberately declare no top-level `bin`: pnpm chmods every bin target while it
# links a workspace: sibling from its SOURCE dir, where src/**/*.js does not exist until tsc runs, so
# a top-level bin there means 28 `WARN Failed to create bin ... ENOENT ... chmod` per install. Moving
# them to publishConfig.bin removes that hazard (see CLAUDE.md, "No bin shims").
#
# `pnpm pack` and `pnpm publish` hoist publishConfig.bin into bin automatically, which is what the
# change was verified against. THIS SCRIPT PUBLISHES WITH `npm publish`, AND NPM DOES NOT — it treats
# publishConfig.bin as an unknown key and leaves it there, so the published manifest had no `bin` and
# consumers installed a package with no executables. Verifying with the wrong package manager is the
# whole lesson: what ships is whatever `npm publish dist/<dir>` puts on the registry.
#
# Doing it HERE, on dist, is the fix rather than a workaround: the ENOENT hazard is a property of the
# SOURCE tree (pnpm never links from dist), so the published manifest can carry an ordinary `bin` with
# no downside. Idempotent — a manifest that already has `bin` is left alone.
for dir in "${ORDER[@]}"; do
    manifest="dist/$dir/package.json"
    [ -f "$manifest" ] || continue
    [ "$(jq -r 'if (.publishConfig.bin // empty) then "yes" else "no" end' "$manifest")" = "yes" ] || continue

    tmp="$(mktemp)"
    jq '.bin = (.bin // .publishConfig.bin) | del(.publishConfig.bin)' "$manifest" > "$tmp"
    mv "$tmp" "$manifest"

    n="$(jq -r '(.bin // {}) | length' "$manifest")"
    if [ "$n" -eq 0 ]; then
        echo "  ❌ $manifest declared publishConfig.bin but the hoist produced no bin entries"
        failed=1
    else
        echo "  🔧 hoisted $n bin(s) into $manifest"
    fi
done

# 4. FAIL CLOSED on a package that ships no executables when its SOURCE says it should. This is the
#    assertion 0.4.575 did not have: the release completed successfully and the breakage was only
#    visible to whoever installed it next.
for dir in "${ORDER[@]}"; do
    src_bins="$(jq -r '((.bin // {}) + (.publishConfig.bin // {})) | length' "$dir/package.json" 2>/dev/null || echo 0)"
    [ "$src_bins" -gt 0 ] || continue
    dist_bins="$(jq -r '(.bin // {}) | length' "dist/$dir/package.json" 2>/dev/null || echo 0)"
    if [ "$dist_bins" -ne "$src_bins" ]; then
        echo "  ❌ $dir declares $src_bins bin(s) but dist/$dir/package.json would publish $dist_bins"
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
