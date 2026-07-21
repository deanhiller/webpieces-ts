#!/bin/bash
set -e

# Read base version from VERSION file
BASE_VERSION=$(cat VERSION | tr -d '[:space:]')

# Get build number from environment or default to 'dev'
BUILD_NUMBER=${BUILD_NUMBER:-dev}

# Construct full version
if [ "$BUILD_NUMBER" = "dev" ]; then
  FULL_VERSION="0.0.0-dev"
else
  FULL_VERSION="${BASE_VERSION}.${BUILD_NUMBER}"
fi

echo "📦 Setting version to: $FULL_VERSION"
echo "   Base version: $BASE_VERSION"
echo "   Build number: $BUILD_NUMBER"

# Update all package.json files in packages/
update_package() {
  local pkg_file=$1
  echo "   Updating: $pkg_file"

  # Create temp file
  local tmp_file=$(mktemp)

  # Update version
  jq --arg ver "$FULL_VERSION" '.version=$ver' "$pkg_file" > "$tmp_file"

  # Update @webpieces/* dependencies to match (handles both "workspace:*" and version strings)
  jq --arg ver "$FULL_VERSION" '
    if .dependencies then
      .dependencies |= with_entries(
        if .key | startswith("@webpieces/") then
          .value = $ver
        else
          .
        end
      )
    else
      .
    end
  ' "$tmp_file" > "$tmp_file.2"

  # Move back
  mv "$tmp_file.2" "$pkg_file"
  rm -f "$tmp_file"
}

# Update source package.json files.
# Glob every <group>/<pkg> under packages/ (core, http, tooling, cloud, …) so a NEW
# package group can never be silently missed — the old hardcoded core/http/tooling list
# dropped packages/cloud/* (gcp-identity, cloudtasks-client), publishing them as 0.0.0-dev.
echo "📝 Updating source package.json files..."
for pkg in packages/*/*/package.json; do
  if [ -f "$pkg" ]; then
    update_package "$pkg"
  fi
done

# Update dist package.json files if they exist
if [ -d "dist/packages" ]; then
  echo "📝 Updating dist package.json files..."
  for pkg in dist/packages/*/*/package.json; do
    if [ -f "$pkg" ]; then
      update_package "$pkg"
    fi
  done
fi

# Stamp the ai-hook shim with the version+sha actually being published.
#
# The committed .claude/webpieces/ai-hook.sh in a CONSUMER repo is the file that decides every tool
# call, and until now it carried no clue which webpieces wrote it — so "does this repo's guard predate
# the fix?" was answerable only by diffing it against an npm tarball. Line 2 now answers it directly.
#
# BOTH artifacts must be stamped in lockstep: templates/ai-hook.sh (what the self-guard cmp's against)
# and the compiled shim.js (whose renderShim() writes the consumer's committed shim). Stamp one and not
# the other and every consumer fail-closes forever on a phantom hand-edit. So this replaces the token
# everywhere it appears under dist/, and then VERIFIES none survived.
PLACEHOLDER="REPLACEME_GIT_HASH_VERSION"
if [ -d "dist/packages" ]; then
  SHORT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  STAMP="$FULL_VERSION ($SHORT_SHA)"
  echo "🔖 Stamping ai-hook shim with: $STAMP"
  # -l lists only matching files, so the loop is over the handful that actually carry the token.
  grep -rl "$PLACEHOLDER" dist/packages 2>/dev/null | while read -r f; do
    echo "   Stamping: $f"
    tmp_file=$(mktemp)
    sed "s/$PLACEHOLDER/$STAMP/g" "$f" > "$tmp_file"
    cat "$tmp_file" > "$f"      # preserve the destination's mode (the shim must stay executable)
    rm -f "$tmp_file"
  done
  if grep -rq "$PLACEHOLDER" dist/packages 2>/dev/null; then
    echo "❌ $PLACEHOLDER survived in dist — the shim would ship unstamped:"
    grep -rl "$PLACEHOLDER" dist/packages
    exit 1
  fi
fi

echo "✅ Version set to $FULL_VERSION for all packages"
