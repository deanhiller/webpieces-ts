import { EnforceControllerNamingConfig } from './rule-configs';

// ---------------------------------------------------------------------------
// enforce-controller-naming — pure detector shared by BOTH engines (ai-hook-rules edit-time,
// code-rules build-time), mirroring findMatchRuleViolations in match-rules-config.ts.
//
// Every class whose heritage ends in `*Api` (`extends XxxApi` / `implements XxxApi`) must DECLARE
// ITS INTENT with one of two decorators:
//   - `@Controller`    → it IS a controller, and must then be named `{Something}Controller`
//                        AND live in a lower-case kebab file `{something}-controller.ts`.
//   - `@NotController` → it is deliberately NOT a controller (a simulator/client/test double),
//                        and is exempt from the naming rules.
// A class implementing `*Api` with NEITHER decorator is a violation ("declare your intent").
// Any `@Controller`-decorated class is also naming-checked even without `*Api` heritage.
//
// The kebab file name is the real deliverable: a separate controller-discovery tool globs
// `**/*-controller.ts`, which only works if every controller file follows the convention.
//
// `allowedPaths` still exempts whole dirs (e.g. generated code); test files are always exempt.
// ---------------------------------------------------------------------------

/** One naming violation. `message` differs per kind (class-name vs file-name) — callers surface it. */
export class ControllerNamingViolation {
    readonly line: number;
    readonly context: string;
    readonly message: string;

    constructor(line: number, context: string, message: string) {
        this.line = line;
        this.context = context;
        this.message = message;
    }
}

const CONTROLLER_SUFFIX = 'Controller';

const TEST_PATHS: readonly RegExp[] = [/\.test\.ts$/, /\.spec\.ts$/, /__tests__\//];

// Glob → RegExp, matching the convention used by no-symbol-di-tokens / match-rules (`**` spans path
// separators, `*` stays within a segment). Kept local so rules-config owns no shared glob util.
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

/** A file is exempt if it's a test file or matches one of the rule's allowedPaths globs. */
export function isControllerNamingAllowedPath(relativePath: string, allowedPaths: readonly string[]): boolean {
    if (TEST_PATHS.some((re: RegExp) => re.test(relativePath))) return true;
    return allowedPaths.some((pattern: string) => globToRegex(pattern).test(relativePath));
}

/**
 * PascalCase → kebab-case. Inserts a `-` before an uppercase letter that follows a lower-case
 * letter or a digit, then lower-cases everything. `SaveController` → `save-controller`,
 * `Server2Controller` → `server2-controller`, `UserAccountController` → `user-account-controller`.
 */
export function toKebabCase(name: string): string {
    let out = '';
    for (let i = 0; i < name.length; i += 1) {
        const ch = name[i] ?? '';
        const prev = name[i - 1];
        if (i > 0 && /[A-Z]/.test(ch) && prev !== undefined && /[a-z0-9]/.test(prev)) {
            out += '-';
        }
        out += ch.toLowerCase();
    }
    return out;
}

const CLASS_DECL = /(?:^|\s)(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;

// The heritage segment (everything after the class name, up to the opening `{`) declares a
// controller contract when it `extends`/`implements` an identifier ending in `Api`.
function heritageMentionsApi(segment: string): boolean {
    return /\b(?:extends|implements)\b/.test(segment) && /\b[A-Za-z_$][\w$]*Api\b/.test(segment);
}

/** Which intent decorators sit directly above a class declaration. */
class ClassDecorators {
    readonly controller: boolean;
    readonly notController: boolean;

    constructor(controller: boolean, notController: boolean) {
        this.controller = controller;
        this.notController = notController;
    }
}

// Walk UP from the class line over the decorator/blank lines that precede it, collecting the
// `@Controller` / `@NotController` intent markers. Stops at the first real (non-decorator, non-blank)
// line. `@NotController` is matched first so `@Controller`'s \b test can't swallow it.
function scanClassDecorators(strippedLines: readonly string[], classLineIndex: number): ClassDecorators {
    let controller = false;
    let notController = false;
    for (let j = classLineIndex - 1; j >= 0; j -= 1) {
        const s = (strippedLines[j] ?? '').trim();
        if (s === '') continue;
        if (!s.startsWith('@')) break;
        if (/@NotController\b/.test(s)) notController = true;
        else if (/@Controller\b/.test(s)) controller = true;
    }
    return new ClassDecorators(controller, notController);
}

// Collect the heritage text of the class declared on `strippedLines[classLineIndex]`. Heritage may
// wrap onto following lines, so we accumulate until the opening `{` (bounded to a few lines).
function collectHeritage(strippedLines: readonly string[], classLineIndex: number, afterName: string): string {
    let combined = afterName;
    let k = classLineIndex;
    while (!combined.includes('{') && k - classLineIndex < 6 && k + 1 < strippedLines.length) {
        k += 1;
        combined += ' ' + (strippedLines[k] ?? '');
    }
    return combined.split('{')[0] ?? combined;
}

function baseName(relativePath: string): string {
    const segments = relativePath.split('/');
    return segments[segments.length - 1] ?? relativePath;
}

/**
 * Pure engine. Scans the (comment/string-stripped) lines for controller classes and returns raw
 * naming violations — NO disable filtering (ai-hook applies isLineDisabled; code-rules applies
 * hasDisable). Returns [] for exempt paths (test files / allowedPaths).
 */
export function findControllerNamingViolations(
    strippedLines: readonly string[],
    relativePath: string,
    config: EnforceControllerNamingConfig,
): ControllerNamingViolation[] {
    if (isControllerNamingAllowedPath(relativePath, config.allowedPaths ?? [])) return [];

    const violations: ControllerNamingViolation[] = [];
    const base = baseName(relativePath);

    for (let i = 0; i < strippedLines.length; i += 1) {
        const line = strippedLines[i] ?? '';
        const match = CLASS_DECL.exec(line);
        if (!match) continue;

        const className = match[1] ?? '';
        const afterName = line.slice((match.index ?? 0) + match[0].length);
        const heritage = collectHeritage(strippedLines, i, afterName);
        const context = line.trim();

        const decorators = scanClassDecorators(strippedLines, i);
        const implementsApi = heritageMentionsApi(heritage);

        // Not a controller and not an *Api implementer → nothing to enforce here.
        if (!decorators.controller && !implementsApi) continue;
        // Implements *Api but explicitly opted out of being a controller → exempt.
        if (!decorators.controller && decorators.notController) continue;

        if (!decorators.controller) {
            // Implements *Api but declared no intent (no @Controller / @NotController).
            violations.push(new ControllerNamingViolation(
                i + 1,
                context,
                `Class "${className}" implements/extends an *Api contract, so it must declare its intent: add @Controller (then name it "{Something}${CONTROLLER_SUFFIX}" in a "{something}-controller.ts" file) OR add @NotController if it is deliberately not a controller.`,
            ));
            continue;
        }

        // @Controller-decorated → enforce the naming convention.
        if (!className.endsWith(CONTROLLER_SUFFIX)) {
            violations.push(new ControllerNamingViolation(
                i + 1,
                context,
                `Controller class "${className}" must be named "{Something}${CONTROLLER_SUFFIX}" (its name must end in "${CONTROLLER_SUFFIX}").`,
            ));
            continue;
        }

        const expected = `${toKebabCase(className)}.ts`;
        if (base !== expected) {
            violations.push(new ControllerNamingViolation(
                i + 1,
                context,
                `Controller file for class "${className}" must be named "${expected}" (lower-case kebab), but the file is "${base}". The controller-discovery tool finds controllers by globbing **/*-controller.ts.`,
            ));
        }
    }

    return violations;
}
