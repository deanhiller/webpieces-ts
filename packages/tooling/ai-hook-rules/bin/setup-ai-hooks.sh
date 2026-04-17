#!/bin/bash
set -e

# setup-ai-hooks.sh — Wires the @webpieces/ai-hooks framework into a project.
#
# For Claude Code: creates .webpieces/ai-hooks/claude-code-hook.js bootstrap,
# seeds webpieces.ai-hooks.json, and merges .claude/settings.json.
#
# Usage:
#   npx wp-setup-ai-hooks

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Detect workspace vs consumer
if [[ "$SCRIPT_DIR" == *"node_modules/@webpieces/ai-hooks"* ]]; then
    # Running in consumer project (from node_modules)
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
    AI_HOOKS_PKG="@webpieces/ai-hooks"
    ADAPTER_REQUIRE="require('${AI_HOOKS_PKG}/claude-code').main();"
    TEMPLATES_DIR="$SCRIPT_DIR/../templates"
else
    # Running in webpieces-ts workspace
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
    ADAPTER_REQUIRE="require('${PROJECT_ROOT}/dist/packages/tooling/ai-hooks/src/adapters/claude-code-hook').main();"
    TEMPLATES_DIR="$SCRIPT_DIR/../templates"
fi

cd "$PROJECT_ROOT" || exit 1

echo ""
echo "🔧 Setting up @webpieces/ai-hooks..."
echo "   Project root: $PROJECT_ROOT"
echo ""

# 1. Create .webpieces/ai-hooks/
mkdir -p .webpieces/ai-hooks

# 2. Generate the bootstrap
BOOTSTRAP=".webpieces/ai-hooks/claude-code-hook.js"
cat > "$BOOTSTRAP" <<JSEOF
#!/usr/bin/env node
${ADAPTER_REQUIRE}
JSEOF
chmod +x "$BOOTSTRAP"
echo "   ✅ Created $BOOTSTRAP"

# 3. Seed webpieces.ai-hooks.json if missing
if [ ! -f "webpieces.ai-hooks.json" ]; then
    cp "$TEMPLATES_DIR/webpieces.ai-hooks.seed.json" "webpieces.ai-hooks.json"
    echo "   ✅ Created webpieces.ai-hooks.json (default config)"
else
    echo "   ℹ️  webpieces.ai-hooks.json already exists (keeping yours)"
fi

# 4. Add .webpieces/ to .gitignore if missing
if [ -f ".gitignore" ]; then
    if ! grep -q "^\.webpieces/" ".gitignore" 2>/dev/null; then
        echo "" >> .gitignore
        echo "# Generated @webpieces/ai-hooks artifacts" >> .gitignore
        echo ".webpieces/" >> .gitignore
        echo "   ✅ Added .webpieces/ to .gitignore"
    fi
else
    echo ".webpieces/" > .gitignore
    echo "   ✅ Created .gitignore with .webpieces/"
fi

# 5. Create or merge .claude/settings.json
mkdir -p .claude

SETTINGS=".claude/settings.json"
HOOK_COMMAND="node .webpieces/ai-hooks/claude-code-hook.js"

if [ ! -f "$SETTINGS" ]; then
    # Fresh settings file
    cat > "$SETTINGS" <<JSONEOF
{
    "hooks": {
        "PreToolUse": [
            {
                "matcher": "Write|Edit|MultiEdit",
                "hooks": [
                    {
                        "type": "command",
                        "command": "${HOOK_COMMAND}"
                    }
                ]
            }
        ]
    }
}
JSONEOF
    echo "   ✅ Created $SETTINGS with PreToolUse hook"
else
    # Settings exist — check if hook is already wired
    if grep -q "claude-code-hook.js" "$SETTINGS" 2>/dev/null; then
        echo "   ℹ️  $SETTINGS already has the ai-hooks hook wired"
    else
        echo ""
        echo "   ⚠️  $SETTINGS exists but doesn't have the ai-hooks hook."
        echo "   Please manually add this to your hooks.PreToolUse array:"
        echo ""
        echo '   {'
        echo '       "matcher": "Write|Edit|MultiEdit",'
        echo '       "hooks": [{'
        echo '           "type": "command",'
        echo "           \"command\": \"${HOOK_COMMAND}\""
        echo '       }]'
        echo '   }'
        echo ""
    fi
fi

# 6. Smoke test
echo ""
echo "🧪 Running smoke test..."
SMOKE_RESULT=$(echo '{"tool_name":"Write","tool_input":{"file_path":"'${PROJECT_ROOT}'/x.ts","content":"const x: any = 1;"}}' | node "$BOOTSTRAP" 2>&1; echo "EXIT:$?")
SMOKE_EXIT=$(echo "$SMOKE_RESULT" | grep "EXIT:" | sed 's/EXIT://')

if [ "$SMOKE_EXIT" = "2" ]; then
    echo "   ✅ Smoke test passed (exit 2 = correctly blocked)"
else
    echo "   ⚠️  Smoke test returned exit $SMOKE_EXIT (expected 2). The hook may not be working."
    echo "   Check that the project built successfully: nx build ai-hooks"
fi

echo ""
echo "🎉 Setup complete!"
echo ""
echo "   Claude Code: restart your session for the hook to activate."
echo "   Edit webpieces.ai-hooks.json to toggle rules or tune options."
echo ""
echo "   Openclaw: install globally with:"
echo "     openclaw plugins install @webpieces/ai-hooks"
echo "     openclaw plugins enable @webpieces/ai-hooks"
echo "   Then drop webpieces.ai-hooks.json into any project."
echo ""
