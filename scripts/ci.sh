#!/bin/bash
# CI Script - Mirrors .github/workflows/ci.yml
#
# Runs the same CI checks as GitHub Actions:
# - lint (parallel)
# - architecture validations (parallel)
# - build (after validations)
# - test (after build)
#
# Uses --affected because validate-new-methods and validate-modified-methods
# require comparing against a base branch.
#
# Usage:
#   ./scripts/ci.sh    # Run affected CI (compared to origin/main)

set -e

echo "🔄 Fetching origin/main to ensure we have latest..."
git fetch origin main

echo ""
echo "📋 Running CI on AFFECTED projects (compared to origin/main)..."
echo "   This mirrors: .github/workflows/ci.yml"
echo ""

npx nx affected --target=ci --base=origin/main
