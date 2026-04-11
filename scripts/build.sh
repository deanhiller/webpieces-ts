#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────
# build.sh — Cross-platform node_modules manager + build runner
#
# Usage:
#   ./scripts/build.sh              # swap to current platform & build
#   ./scripts/build.sh swap         # just swap node_modules (no build)
#   ./scripts/build.sh build        # just build (assume correct node_modules)
#   ./scripts/build.sh lint         # just lint
#   ./scripts/build.sh clean        # remove all node_modules (all platforms)
# ─────────────────────────────────────────────────────────────────────

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

# Detect platform
detect_platform() {
    local os arch
    os="$(uname -s)"
    arch="$(uname -m)"
    case "$os-$arch" in
        Darwin-arm64)  echo "mac" ;;
        Darwin-x86_64) echo "mac_x64" ;;
        Linux-aarch64) echo "linux" ;;
        Linux-x86_64)  echo "linux_x64" ;;
        *)             echo "unknown_${os}_${arch}" ;;
    esac
}

PLATFORM="$(detect_platform)"
NM_DIR="node_modules"
NM_PLATFORM="${NM_DIR}_${PLATFORM}"

echo "📦 Platform: $PLATFORM"
echo "📂 Project:  $PROJECT_DIR"

ensure_gitignore() {
    # Make sure node_modules_* dirs are ignored by git and Nx
    for ignore_file in .gitignore .nxignore; do
        if [ -f "$ignore_file" ]; then
            if ! grep -q "node_modules_" "$ignore_file" 2>/dev/null; then
                echo "" >> "$ignore_file"
                echo "# Platform-specific node_modules backups" >> "$ignore_file"
                echo "node_modules_*/" >> "$ignore_file"
                echo "📝 Added node_modules_*/ to $ignore_file"
            fi
        fi
    done
}

swap_node_modules() {
    ensure_gitignore

    # If node_modules is already for this platform, nothing to do
    if [ -f "$NM_DIR/.platform" ] && [ "$(cat "$NM_DIR/.platform")" = "$PLATFORM" ]; then
        echo "✅ node_modules already set for $PLATFORM"
        return 0
    fi

    # Save current node_modules under its platform name (if it has one)
    if [ -d "$NM_DIR" ]; then
        if [ -f "$NM_DIR/.platform" ]; then
            local old_platform
            old_platform="$(cat "$NM_DIR/.platform")"
            local old_nm="${NM_DIR}_${old_platform}"
            echo "📦 Saving current node_modules as ${old_nm}/"
            [ -d "$old_nm" ] && rm -rf "$old_nm"
            mv "$NM_DIR" "$old_nm"
        else
            # Unknown platform — assume it's from the host (mac)
            echo "📦 Saving current node_modules as ${NM_DIR}_unknown/"
            [ -d "${NM_DIR}_unknown" ] && rm -rf "${NM_DIR}_unknown"
            mv "$NM_DIR" "${NM_DIR}_unknown"
        fi
    fi

    # Restore platform-specific node_modules if we have one cached
    if [ -d "$NM_PLATFORM" ]; then
        echo "♻️  Restoring cached ${NM_PLATFORM}/"
        mv "$NM_PLATFORM" "$NM_DIR"
        echo "✅ Swapped to $PLATFORM node_modules"
    else
        echo "🔨 No cached node_modules for $PLATFORM — running npm install..."
        npm install
        # Install platform-specific native binaries that npm skips as optionalDeps
        # when the lockfile was created on a different platform
        if [ "$PLATFORM" = "linux" ] || [ "$PLATFORM" = "linux_x64" ]; then
            # Check if Nx is used and linux binary is missing
            if [ -d "node_modules/nx" ] && [ ! -d "node_modules/@nx/nx-linux-arm64-gnu" ] && [ "$PLATFORM" = "linux" ]; then
                local nx_ver
                nx_ver=$(node -pe "require('./node_modules/nx/package.json').version")
                echo "🔧 Installing Nx linux-arm64 native binary v${nx_ver}..."
                npm install --no-save "@nx/nx-linux-arm64-gnu@${nx_ver}" 2>/dev/null || true
            fi
        fi
        echo "$PLATFORM" > "$NM_DIR/.platform"
        echo "✅ Fresh install for $PLATFORM complete"
    fi
}

do_build() {
    echo ""
    echo "🔨 Running build..."
    if [ -f "nx.json" ]; then
        NX_DAEMON=false npx nx run-many --target=build --all
    elif grep -q '"build"' package.json 2>/dev/null; then
        npm run build
    else
        echo "⚠️  No build target found (no nx.json, no 'build' script)"
    fi
}

do_lint() {
    echo ""
    echo "🔍 Running lint..."
    if [ -f "nx.json" ]; then
        NX_DAEMON=false npx nx run-many --target=lint --all
    elif grep -q '"lint"' package.json 2>/dev/null; then
        npm run lint
    else
        echo "⚠️  No lint target found"
    fi
}

do_clean() {
    echo "🧹 Removing all node_modules..."
    rm -rf node_modules node_modules_* 
    echo "✅ Clean"
}

# ─────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────

ACTION="${1:-default}"

case "$ACTION" in
    swap)
        swap_node_modules
        ;;
    build)
        do_build
        ;;
    lint)
        do_lint
        ;;
    clean)
        do_clean
        ;;
    default)
        swap_node_modules
        do_lint
        ;;
    *)
        echo "Usage: $0 [swap|build|lint|clean]"
        echo "  (no args) = swap + lint"
        exit 1
        ;;
esac
