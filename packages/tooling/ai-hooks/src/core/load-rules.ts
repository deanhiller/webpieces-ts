import * as fs from 'fs';
import * as path from 'path';

import type { Rule, ResolvedConfig } from './types';

const REQUIRED_FIELDS: readonly string[] = ['name', 'description', 'scope', 'files', 'check'];
const VALID_SCOPES = new Set(['edit', 'file']);

export function loadRules(config: ResolvedConfig, workspaceRoot: string): readonly Rule[] {
    const builtIns = loadBuiltInRules();
    const custom = loadCustomRules(config.rulesDir, workspaceRoot);
    const all = [...builtIns, ...custom];
    return all.filter((rule) => validateRule(rule));
}

function loadBuiltInRules(): Rule[] {
    const registry: readonly string[] = require('./rules').builtInRules;
    const modules: Rule[] = [];
    for (const relPath of registry) {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const mod = require(relPath);
            modules.push(mod.default || mod);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[ai-hooks] failed to load built-in rule ${relPath}: ${msg}\n`);
        }
    }
    return modules;
}

function loadCustomRules(rulesDirs: readonly string[], workspaceRoot: string): Rule[] {
    const modules: Rule[] = [];
    for (const dir of rulesDirs) {
        const absDir = path.isAbsolute(dir) ? dir : path.join(workspaceRoot, dir);
        if (!fs.existsSync(absDir)) {
            process.stderr.write(`[ai-hooks] rulesDir not found: ${absDir}\n`);
            continue;
        }
        let entries: string[];
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            entries = fs.readdirSync(absDir).filter((e) => e.endsWith('.js'));
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[ai-hooks] cannot read rulesDir ${absDir}: ${msg}\n`);
            continue;
        }
        for (const entry of entries) {
            const full = path.join(absDir, entry);
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
            try {
                const mod = require(full);
                modules.push(mod.default || mod);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`[ai-hooks] failed to load custom rule ${full}: ${msg}\n`);
            }
        }
    }
    return modules;
}

// webpieces-disable no-any-unknown -- validates untrusted require() output at system boundary
function validateRule(rule: unknown): rule is Rule {
    if (!rule || typeof rule !== 'object') {
        process.stderr.write('[ai-hooks] rule is not an object, skipping\n');
        return false;
    }
    // webpieces-disable no-any-unknown -- narrowing from unknown at system boundary
    const obj = rule as Record<string, unknown>;
    for (const field of REQUIRED_FIELDS) {
        if (obj[field] === undefined) {
            const name = typeof obj['name'] === 'string' ? obj['name'] : '<unnamed>';
            process.stderr.write(`[ai-hooks] rule "${name}" missing required field: ${field}\n`);
            return false;
        }
    }
    if (!VALID_SCOPES.has(obj['scope'] as string)) {
        process.stderr.write(`[ai-hooks] rule "${obj['name']}" has invalid scope: ${String(obj['scope'])}\n`);
        return false;
    }
    if (!Array.isArray(obj['files'])) {
        process.stderr.write(`[ai-hooks] rule "${obj['name']}" files must be an array\n`);
        return false;
    }
    if (typeof obj['check'] !== 'function') {
        process.stderr.write(`[ai-hooks] rule "${obj['name']}" check must be a function\n`);
        return false;
    }
    return true;
}

export function globMatches(pattern: string, filePath: string): boolean {
    const regex = globToRegex(pattern);
    return regex.test(filePath);
}

function globToRegex(pattern: string): RegExp {
    let re = '';
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === '*') {
            if (pattern[i + 1] === '*') {
                re += '.*';
                i += 2;
                if (pattern[i] === '/') i += 1;
                continue;
            }
            re += '[^/]*';
            i += 1;
            continue;
        }
        if (ch === '?') {
            re += '[^/]';
            i += 1;
            continue;
        }
        if ('.+^$(){}|[]\\'.includes(ch)) {
            re += '\\' + ch;
            i += 1;
            continue;
        }
        re += ch;
        i += 1;
    }
    return new RegExp('^' + re + '$');
}
