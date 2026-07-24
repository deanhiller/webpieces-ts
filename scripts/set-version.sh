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

# NOTE (2026-07-24): the ai-hook shim no longer carries a version stamp, so there is nothing to rewrite
# here. It used to embed `# webpieces shim version: <v> (<sha>)` on line 2, which made the committed
# .claude/webpieces/ai-hook.sh go byte-different on EVERY release even when its logic was identical —
# tripping the committed-shim self-guard on every upgrade over a comment, and risking a permanent
# fail-close if the two lockstep artifacts were ever stamped unevenly. The shim is now intentionally
# version-AGNOSTIC and byte-STABLE across releases; the installed guards binary reports its own version
# in the deny text when it needs to. See renderShim() in packages/tooling/ai-hook-rules/src/bin/shim.ts.

echo "✅ Version set to $FULL_VERSION for all packages"
