#!/bin/bash
exec node "$(git rev-parse --show-toplevel)/node_modules/@webpieces/ai-hook-rules/src/scripts/git-gatherInfo.js" "$@"
