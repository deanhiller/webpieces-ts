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

  # Update @webpieces/* dependencies to match
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

# Update source package.json files
echo "📝 Updating source package.json files..."
for pkg in packages/core/*/package.json packages/http/*/package.json packages/tooling/*/package.json packages/server/package.json packages/client/package.json packages/rules/package.json; do
  if [ -f "$pkg" ]; then
    update_package "$pkg"
  fi
done

# Update dist package.json files if they exist
if [ -d "dist/packages" ]; then
  echo "📝 Updating dist package.json files..."
  for pkg in dist/packages/core/*/package.json dist/packages/http/*/package.json dist/packages/tooling/*/package.json dist/packages/server/package.json dist/packages/client/package.json dist/packages/rules/package.json; do
    if [ -f "$pkg" ]; then
      update_package "$pkg"
    fi
  done
fi

echo "✅ Version set to $FULL_VERSION for all packages"
