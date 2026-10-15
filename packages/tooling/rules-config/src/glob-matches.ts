/**
 * THE glob matcher of every path exclusion webpieces applies (#1253): the top-level `excludePaths` and
 * each rule's own `excludePaths`, in the hooks AND in the build — one matcher, so one list means one
 * thing everywhere. `**` crosses directories (a following `/` is optional), `*` and `?` stay inside one
 * segment, and the whole workspace-relative path must match (anchored). It moved here from hook-runtime
 * so the code-rules build path can apply the same lists with the same answer.
 */
// webpieces-disable no-function-outside-class -- existing stateless module helper moved intact with its callers; ownership extraction preserves its functional API
export function globMatches(pattern: string, filePath: string): boolean {
    const regex = globToRegex(pattern);
    return regex.test(filePath);
}

// webpieces-disable no-function-outside-class -- existing stateless module helper moved intact with its callers; ownership extraction preserves its functional API
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
