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
