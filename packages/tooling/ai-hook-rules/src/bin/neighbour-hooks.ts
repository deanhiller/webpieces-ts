import * as fs from 'fs';
import * as path from 'path';

import { SHIM_MARKER } from './shim';
// The SHAPE only, from the leaf module both this file and hook-registration.ts point at. This module
// deliberately knows nothing about `HarnessRegistration`: it takes the harness's ANCHOR as a string, so
// there is no edge back to hook-registration at all — not even a type-only one, which
// `validate-no-file-import-cycles` counts as a cycle just the same.
import type { ClaudeSettings, HookCommand, HookEntry } from './settings-shape';

/**
 * NEIGHBOUR HOOKS — the hooks a CONSUMER repo registers in the SAME settings file webpieces manages,
 * and the one thing about them webpieces must own: their entry path has to be ABSOLUTE.
 *
 * ─── The defect (issue #852, MEASURED in a consumer repo) ─────────────────────────────────────────
 * A repo registered five of its own guards RELATIVE, beside webpieces' one absolute entry:
 *
 *     { "type": "command", "command": "node \".claude/hooks/guard-deploy.mjs\"" }
 *
 * A relative entry path resolves against the HOOK PROCESS's cwd. The moment that cwd is not the repo
 * root, node cannot resolve the entry module and the guard dies before running a line:
 *
 *     $ cd <repo>/services && echo '{}' | node ".claude/hooks/guard-deploy.mjs"
 *     Error: Cannot find module '<repo>/services/.claude/hooks/guard-deploy.mjs'
 *
 * Per the hooks reference that non-zero exit is a NON-BLOCKING error — a SILENT UNGUARDED ALLOW. So
 * every Bash call printed five `PreToolUse:Bash hook error` stack-trace fragments, carrying no rule
 * name and no verdict, and then RAN ANYWAY. The guards that stopped running were the security ones: a
 * cleartext-credentials blocker, a `gcloud` blocker (the CLI ignores GOOGLE_APPLICATION_CREDENTIALS and
 * would otherwise run as the developer's OWNER account) and a raw-deploy blocker. That is the exact
 * inverse of the fail-closed property those guards are documented to have.
 *
 * ─── Why webpieces owns the fix rather than the consumer ──────────────────────────────────────────
 * 1. The consumer is told `.claude/settings.json` is GENERATED and must never be hand-edited, so it
 *    cannot fix its own registration without fighting `wp-upgrade-shim` on the next bump.
 * 2. webpieces already learned this lesson for its OWN hook — the relative→absolute reversal documented
 *    at length in hook-registration.ts's header, which cost an entire guard layer (L-1) before it was
 *    reversed. That reasoning was never extended to the entries co-registered beside it, and the
 *    failure mode is identical because it is a property of the FILE, not of who wrote the line.
 *
 * ─── The conservative rule, and why the cure always converges ─────────────────────────────────────
 * A token is anchored ONLY when every one of these holds: it is not already absolute, variable-anchored
 * or `~`-anchored; it contains a `/`; it does not escape the root with `..`; and — the load-bearing
 * one — `<root>/<token>` EXISTS ON DISK. That last test is what keeps `npm run build/foo` and every
 * other slash-carrying non-path untouched, and it is why drift is defined as "the repair would change
 * something" rather than "a relative-looking token is present": a token this module declines to anchor
 * never becomes drift, so fault S can never name a surface its own cure cannot repair.
 *
 * This is deliberately NOT a second spelling of the managed registration. Anything under the managed
 * directory — `MANAGED_DIR`, derived below from `SHIM_MARKER` itself rather than re-spelled — is skipped
 * here, so every webpieces-owned command is left to `repairRegistration()`, which is the ONE place their
 * spelling is defined. The test is the DIRECTORY and not `isManagedCommand()`: this module holds no edge
 * back to hook-registration.ts, precisely so the file-import cycle stays broken.
 */

/**
 * The webpieces-MANAGED directory, derived from the shim's own path so there is never a second spelling
 * of it. Everything under it is rewritten wholesale by `repairRegistration()`, which is the ONE place
 * the managed commands' shape is defined — anchoring a token there from here would be a second spelling
 * of one registration, exactly the shim shape the compatibility policy rejects.
 */
const MANAGED_DIR = `${SHIM_MARKER.slice(0, SHIM_MARKER.lastIndexOf('/'))}/`;

/**
 * How a drifted NEIGHBOUR surface is spelled, and the ONE place that spelling lives.
 *
 * `HarnessRegistration.neighbourSurface` builds a name ending in this, and the fault-S deny tests the
 * drift list against it to decide whether to spend a line teaching this failure mode. Two literals would
 * be two spellings of one thing: the deny would go quietly wrong — printing nothing for the one surface
 * it exists to explain — with no test able to see it.
 */
export const NEIGHBOUR_SURFACE_SUFFIX = 'relative hook commands';

/** A token that is already anchored (absolute, `$VAR`, `~`) or is a flag — never a relative entry path. */
const ALREADY_ANCHORED = /^[/~$-]/;

/** Quoted-or-bare token scan. Quotes are tried first so a quoted path is one token, not several. */
const COMMAND_TOKEN = /"([^"]*)"|'([^']*)'|(\S+)/g;

/**
 * Rewrites the repo-relative entry paths in ONE hook command to `<anchor>/<path>`.
 *
 * `anchor` is the harness's own — `$CLAUDE_PROJECT_DIR` for Claude Code, `$PWD` for Codex — so a
 * neighbour hook is anchored exactly the way webpieces anchors its own, and the MAIN tree governs every
 * tree for the consumer's guards too.
 */
export class NeighbourHookAnchor {
    constructor(
        private readonly anchor: string,
        private readonly root: string,
    ) {}

    /** The command with every anchorable token anchored; returns the input unchanged when there is none. */
    rewrite(command: string): string {
        return command.replace(COMMAND_TOKEN, (whole: string, dq?: string, sq?: string, bare?: string): string => {
            const token = dq ?? sq ?? bare ?? '';
            const anchored = this.anchorToken(token);
            if (anchored === null) return whole;
            if (sq !== undefined) return `'${anchored}'`;
            // A bare token is QUOTED on the way out, not left bare: the anchor expands to a real
            // filesystem path, and a checkout under a directory with a space in it would otherwise be
            // split into two arguments — which fails exactly as silently as the bug being fixed.
            return `"${anchored}"`;
        });
    }

    /** The anchored spelling of one token, or null when this token must be left exactly as it is. */
    private anchorToken(token: string): string | null {
        if (token === '' || ALREADY_ANCHORED.test(token)) return null;
        if (!token.includes('/') || token.includes('$') || token.includes('~')) return null;
        const rel = token.startsWith('./') ? token.slice(2) : token;
        // `..` escapes the root, so the anchor would not name what the author meant. Leave it and let
        // the drift check stay silent about it — a surface the cure cannot repair must never be reported.
        if (rel === '' || rel.startsWith('../') || rel.startsWith(MANAGED_DIR)) return null;
        if (!fs.existsSync(path.join(this.root, ...rel.split('/')))) return null;
        return `${this.anchor}/${rel}`;
    }
}

/**
 * Every hook entry in a settings file, across EVERY event (PreToolUse, PostToolUse, Stop, …).
 *
 * Not scoped to PreToolUse, because the defect is not: a `PostToolUse` hook registered relative dies the
 * same way from the same cwd, and scoping the repair to one event would leave a half-fixed file that
 * reports success — the failure shape upgrade-shim.ts's header exists to prevent.
 */
// webpieces-disable no-function-outside-class -- module-scope sibling of hook-registration.ts's readers, in the deliberately dependency-free bin layer
function allHookCommands(settings: ClaudeSettings): readonly HookCommand[] {
    const events = settings.hooks;
    if (events === undefined) return [];
    const found: HookCommand[] = [];
    for (const entries of Object.values(events)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries as readonly HookEntry[]) {
            if (Array.isArray(entry.hooks)) found.push(...entry.hooks);
        }
    }
    return found;
}

/**
 * Anchor every neighbour hook command IN PLACE; returns the NEW spelling of each one that changed.
 *
 * The return value is the rewritten commands rather than a boolean so the cure can print what it did to
 * a file it does not own. A cure that silently edits a consumer's own hook lines is worse than one that
 * does not edit them at all.
 */
// webpieces-disable no-function-outside-class -- module-scope sibling of hook-registration.ts's repairs, in the deliberately dependency-free bin layer
export function anchorNeighbourHooks(anchor: string, settings: ClaudeSettings, root: string): readonly string[] {
    const anchorer = new NeighbourHookAnchor(anchor, root);
    const rewritten: string[] = [];
    for (const hook of allHookCommands(settings)) {
        if (typeof hook.command !== 'string') continue;
        const anchored = anchorer.rewrite(hook.command);
        if (anchored === hook.command) continue;
        hook.command = anchored;
        rewritten.push(anchored);
    }
    return rewritten;
}

/**
 * True when this settings file carries a neighbour hook the repair WOULD anchor.
 *
 * Gated on `registeredBins()` by its caller for the same reason `registrationStale()` is: a settings
 * file that registers no webpieces hooks is not a webpieces install, and rewriting somebody's unrelated
 * hooks in it would be webpieces editing a file it was never given.
 */
// webpieces-disable no-function-outside-class -- module-scope sibling of hook-registration.ts's drift checks, in the deliberately dependency-free bin layer
export function neighbourHooksStale(anchor: string, settings: ClaudeSettings, root: string): boolean {
    const anchorer = new NeighbourHookAnchor(anchor, root);
    return allHookCommands(settings).some((h: HookCommand): boolean => typeof h.command === 'string' && anchorer.rewrite(h.command) !== h.command);
}
