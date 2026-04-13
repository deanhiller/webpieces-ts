#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────
# build.sh — Cross-platform node_modules manager + full CI runner
#
# Runs the SAME checks as GitHub Actions CI:
#   lint, build, test, architecture validation (nx affected --target=ci)
#
# Usage:
#   ./scripts/build.sh              # swap + lockfile check + full CI
#   ./scripts/build.sh swap         # just swap node_modules (no CI)
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

# ─────────────────────────────────────────────────────────────────────
# Lockfile freshness check (timestamp-based, instant)
# ─────────────────────────────────────────────────────────────────────
check_lockfile_freshness() {
    if [ ! -f "pnpm-lock.yaml" ]; then
        echo "❌ pnpm-lock.yaml not found — run 'pnpm install'"
        exit 1
    fi

    # Check 1: Any package.json newer than pnpm-lock.yaml means lock file is stale
    if [ "package.json" -nt "pnpm-lock.yaml" ]; then
        echo "❌ package.json is newer than pnpm-lock.yaml"
        echo "   Run 'pnpm install' to update the lock file, then commit it."
        exit 1
    fi
    for pkg in packages/*/package.json packages/*/*/package.json apps/*/package.json apps/*/*/package.json; do
        if [ -f "$pkg" ] && [ "$pkg" -nt "pnpm-lock.yaml" ]; then
            echo "❌ $pkg is newer than pnpm-lock.yaml"
            echo "   Run 'pnpm install' to update the lock file, then commit it."
            exit 1
        fi
    done

    # Check 2: node_modules/.modules.yaml is written by pnpm install.
    # If root pnpm-lock.yaml is newer, node_modules is stale.
    if [ -f "node_modules/.modules.yaml" ]; then
        if [ "pnpm-lock.yaml" -nt "node_modules/.modules.yaml" ]; then
            echo "❌ pnpm-lock.yaml has been updated since last 'pnpm install'"
            echo "   New packages may have been added that are not installed."
            echo "   Run 'pnpm install' to install the updated dependencies."
            exit 1
        fi
    else
        echo "❌ node_modules/.modules.yaml not found"
        echo "   This suggests 'pnpm install' has never been run."
        echo "   Run 'pnpm install' to install dependencies."
        exit 1
    fi

    echo "✅ pnpm-lock.yaml is in sync"
}

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
        echo "🔨 No cached node_modules for $PLATFORM — running pnpm install..."
        pnpm install
        echo "$PLATFORM" > "$NM_DIR/.platform"
        echo "✅ Fresh install for $PLATFORM complete"
    fi
}

do_ci() {
    echo ""
    echo "🔨 Running CI (same as GitHub Actions: lint, build, test, architecture validation)..."
    git fetch origin main 2>/dev/null || true
    pnpm nx affected --target=ci --base=origin/main
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
    clean)
        do_clean
        ;;
    default)
        swap_node_modules
        check_lockfile_freshness
        do_ci
        ;;
    *)
        echo "Usage: $0 [swap|clean]"
        echo "  (no args) = swap + lockfile check + full CI"
        exit 1
        ;;
esac
