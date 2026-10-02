const fs = require('node:fs');
const path = require('node:path');

// Nx rejects forbidden package edges before it builds a task graph.
class HookBoundaries {
    forbidden(owner, dependency) {
        const denied = {
            'ai-hook-rules': ['agent-workflow-rules', 'repo-workflow-core'],
            'agent-workflow-rules': ['ai-hook-rules'],
            'hook-runtime': ['ai-hook-rules', 'agent-workflow-rules', 'repo-workflow-core'],
            'pr-gate': ['ai-hook-rules'],
        };
        return (denied[owner] || []).includes(dependency);
    }

    validate(root) {
        for (const owner of ['ai-hook-rules', 'agent-workflow-rules', 'hook-runtime', 'pr-gate']) {
            const directory = path.join(root, 'packages/tooling', owner);
            const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
            for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
                this.assert(owner, dependency.replace('@webpieces/', ''), 'package.json');
            }
            this.walk(owner, path.join(directory, 'src'));
        }
    }

    walk(owner, directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) this.walk(owner, full);
            else if (entry.name.endsWith('.ts')) {
                const source = fs.readFileSync(full, 'utf8');
                const imports = /(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
                for (const match of source.matchAll(imports)) {
                    const specifier = match[1];
                    const dependency = specifier.startsWith('@webpieces/') ? specifier.split('/')[1]
                        : path.resolve(path.dirname(full), specifier).match(/packages\/tooling\/([^/]+)/)?.[1];
                    if (dependency) this.assert(owner, dependency, full);
                }
            }
        }
    }

    assert(owner, dependency, file) {
        if (this.forbidden(owner, dependency)) throw new Error(`Forbidden hook dependency: ${owner} -> ${dependency} (${file})`);
    }
}

exports.name = 'webpieces-hook-boundaries';
exports.HookBoundaries = HookBoundaries;
exports.createDependencies = async (_options, context) => {
    new HookBoundaries().validate(context.workspaceRoot);
    return [];
};
