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
#
# THE SECOND HALF: A TRANSIENT PUBLISH FAILURE (run 585, 0.4.585)
# ---------------------------------------------------------------
# The preflight above closed the "stale list" hole. It did nothing about the SAME blast radius arriving
# from the registry instead. Run 585 died on entry 21 of 28 with
#
#     npm error code E404
#     npm error 404 Not Found - PUT https://registry.npmjs.org/@webpieces%2fcloudtasks-client
#
# The package already existed at 0.4.584, `npm owner ls` matched packages that published fine in that
# same run, and the previous 7 releases were green — so this was not config or permissions. With npm
# trusted publishing the registry MASKS an auth failure as a 404, and there was a 71-second stall before
# "Publishing to registry", consistent with the short-lived OIDC ID token expiring partway through a long
# sequential publish loop.
#
# `set -e` plus a bare loop turned one transient blip into a SPLIT RELEASE: 10 runtime packages at
# 0.4.585 while cloudtasks-client and the entire tooling family stayed at 0.4.584. Two changes below
# close it:
#
#   - publish_one() RETRIES with backoff, and treats "this exact version is already published" as
#     SUCCESS. That second half is what makes re-running a failed release the correct recovery — before
#     it, a re-run aborted on the first already-published package and never reached the stragglers.
#   - the loop no longer aborts. It records every outcome and, if anything is still unpublished at the
#     end, FAILS with a summary naming what published and what did not. A split release is now loud.

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

# Retry budget for ONE package. Overridable so the spec can run the real script with no sleeping.
PUBLISH_ATTEMPTS="${PUBLISH_ATTEMPTS:-4}"
PUBLISH_RETRY_SLEEP="${PUBLISH_RETRY_SLEEP:-10}"

# Dependency order. A package must appear AFTER everything it depends on: npm has no ordering
# guarantee, and a consumer resolving a not-yet-published version fails.
#
# THE TOOLING FAMILY GOES FIRST, and that is a deliberate risk ordering, not tidiness. These six are
# the packages this repo GOVERNS ITSELF WITH — the eslint plugin, the nx executors, the PreToolUse
# guards and every `wp-*` bin. Stranding them is strictly the worst outcome of a partial release: the
# runtime packages just sit a build behind, but a half-published tooling family desynchronises the
# umbrella from its children and can wedge an agent session (see CLAUDE.md, "Published vs local
# source"). Nothing in the family depends on any runtime package — `rules-config` has no @webpieces
# dependency at all, the middle four depend only on `rules-config`, and `nx-webpieces-rules` bundles
# the other five — so putting them at the front costs nothing and removes them as hostages of a
# transient failure on an unrelated package like cloudtasks-client (entry 21 of 28, run 585).
#
# publish-packages.spec.ts re-derives this from the real manifests, so a new @webpieces
# dependency that invalidates the order fails a test rather than a release.
ORDER=(
    packages/tooling/rules-config
    packages/tooling/eslint-rules
    # ai-hook-rules moved AHEAD of pr-gate when pr-gate began depending on it (BuildAffected consumes
    # CodexGuardPresence for the guard-presence gate). publish-packages.spec.ts re-derives this from
    # the real manifests and caught the inversion.
    packages/tooling/ai-hook-rules
    packages/tooling/pr-gate
    packages/tooling/code-rules
    packages/tooling/nx-webpieces-rules
    # core-util has no @webpieces dependency; core-context depends on it. These two were the wrong way
    # round until publish-packages.spec.ts re-derived the order from the manifests and said so — latent
    # because npm never enforces the order, it just leaves a window where core-context resolves a
    # core-util that is not on the registry yet.
    packages/core/core-util
    packages/core/core-context
    # A test/mock helper with no @webpieces deps. It was in SKIP for a long time because npm
    # trusted publishing (OIDC + --provenance) cannot CREATE a brand-new scoped package — only
    # publish to a name that already exists — so the first-ever publish 404'd and aborted the
    # whole release. Once the name was bootstrapped on npm by an authenticated manual publish,
    # CI can keep it in sync like every other package. Consumers were cloning it
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

# Publish ONE package, retrying a transient registry failure.
#
# The already-published check is the load-bearing half. npm signals it three different ways depending on
# registry and version (code EPUBLISHCONFLICT, a 403, or the prose "You cannot publish over the
# previously published versions"), and all three mean the SAME thing here: the registry already holds
# exactly what this run wanted to put there, which is success by any definition the release cares about.
# Treating it as fatal is what made a plain re-run of run 585 useless — it would have died on entry 1.
#
# Note what is deliberately NOT special-cased: a 404. Under trusted publishing that is npm masking an
# expired OIDC token, i.e. precisely the transient this retry exists for. A genuinely missing package
# name still fails, just after PUBLISH_ATTEMPTS tries.
publish_one() {
    local dir="$1"
    local attempt=1
    local delay="$PUBLISH_RETRY_SLEEP"
    local out=''

    while : ; do
        # shellcheck disable=SC2086 -- PUBLISH_FLAGS is an intentional word-split flag list
        if out="$(npm publish "dist/$dir" $PUBLISH_FLAGS 2>&1)"; then
            printf '%s\n' "$out"
            return 0
        fi
        printf '%s\n' "$out"

        if printf '%s' "$out" | grep -qiE 'EPUBLISHCONFLICT|cannot publish over|previously published version'; then
            echo "  ✅ $dir is already published at this version — treating as success"
            return 0
        fi

        if [ "$attempt" -ge "$PUBLISH_ATTEMPTS" ]; then
            echo "  ❌ $dir failed $attempt attempt(s)"
            return 1
        fi

        echo "  ⚠️  $dir attempt $attempt/$PUBLISH_ATTEMPTS failed — retrying in ${delay}s"
        sleep "$delay"
        delay=$((delay * 2))
        attempt=$((attempt + 1))
    done
}

# The loop does NOT abort on a failure. Aborting is what produced the split release: every package after
# the failing one was never even attempted, and the ones that had already gone out could not be walked
# back. Pressing on publishes everything that CAN publish, and the summary below is what keeps that
# honest — a partial release still exits non-zero and names both halves.
published=()
unpublished=()
for dir in "${ORDER[@]}"; do
    echo "📦 npm publish dist/$dir $PUBLISH_FLAGS"
    if publish_one "$dir"; then
        published+=("$dir")
    else
        unpublished+=("$dir")
    fi
done

echo ""
if [ "${#unpublished[@]}" -ne 0 ]; then
    echo "❌ PARTIAL RELEASE — ${#published[@]} of ${#ORDER[@]} package(s) published"
    echo ""
    echo "Published:"
    for dir in "${published[@]+"${published[@]}"}"; do echo "  ✅ $dir"; done
    echo "NOT published:"
    for dir in "${unpublished[@]}"; do echo "  ❌ $dir"; done
    echo ""
    echo "npm and the git tag now disagree. Re-run this script: already-published packages are skipped,"
    echo "so a re-run publishes only the stragglers."
    exit 1
fi

echo "✅ Published ${#ORDER[@]} package(s)"
