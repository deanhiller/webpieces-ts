interface StackFrame {
    readonly state: string;
    readonly braceDepth: number;
}

class StripState {
    readonly source: string;
    readonly len: number;
    readonly out: string[];
    readonly stack: StackFrame[];
    state: string;
    braceDepth: number;
    i: number;

    constructor(source: string) {
        this.source = source;
        this.len = source.length;
        this.out = new Array<string>(source.length);
        this.stack = [];
        this.state = 'code';
        this.braceDepth = 0;
        this.i = 0;
    }

    ch(): string { return this.source[this.i]; }
    next(): string { return this.i + 1 < this.len ? this.source[this.i + 1] : ''; }
    emit(idx: number, ch: string): void { this.out[idx] = ch; }
    blank(idx: number, ch: string): void { this.out[idx] = ch === '\n' ? '\n' : ' '; }

    pushState(newState: string): void {
        this.stack.push({ state: this.state, braceDepth: this.braceDepth });
        this.state = newState;
    }

    popState(): void {
        const frame = this.stack.pop()!;
        this.state = frame.state;
        this.braceDepth = frame.braceDepth;
    }
}

function handleCodeOrInterp(s: StripState): void {
    const ch = s.ch();
    const next = s.next();

    if (s.state === 'templateInterp') {
        if (ch === '{') { s.braceDepth += 1; s.emit(s.i, ch); s.i += 1; return; }
        if (ch === '}') {
            if (s.braceDepth === 0) { s.emit(s.i, ch); s.i += 1; s.popState(); return; }
            s.braceDepth -= 1; s.emit(s.i, ch); s.i += 1; return;
        }
    }
    if (ch === '/' && next === '/') { s.emit(s.i, '/'); s.emit(s.i + 1, '/'); s.i += 2; s.pushState('lineComment'); return; }
    if (ch === '/' && next === '*') { s.emit(s.i, '/'); s.emit(s.i + 1, '*'); s.i += 2; s.pushState('blockComment'); return; }
    if (ch === '"') { s.emit(s.i, '"'); s.i += 1; s.pushState('dquote'); return; }
    if (ch === "'") { s.emit(s.i, "'"); s.i += 1; s.pushState('squote'); return; }
    if (ch === '`') { s.emit(s.i, '`'); s.i += 1; s.pushState('template'); return; }
    s.emit(s.i, ch); s.i += 1;
}

function handleLineComment(s: StripState): void {
    if (s.ch() === '\n') { s.emit(s.i, '\n'); s.i += 1; s.popState(); return; }
    s.blank(s.i, s.ch()); s.i += 1;
}

function handleBlockComment(s: StripState): void {
    if (s.ch() === '*' && s.next() === '/') { s.emit(s.i, '*'); s.emit(s.i + 1, '/'); s.i += 2; s.popState(); return; }
    s.blank(s.i, s.ch()); s.i += 1;
}

function handleStringLiteral(s: StripState, quoteChar: string): void {
    const ch = s.ch();
    if (ch === '\\' && s.i + 1 < s.len) { s.blank(s.i, ch); s.blank(s.i + 1, s.source[s.i + 1]); s.i += 2; return; }
    if (ch === quoteChar) { s.emit(s.i, quoteChar); s.i += 1; s.popState(); return; }
    s.blank(s.i, ch); s.i += 1;
}

function handleTemplate(s: StripState): void {
    const ch = s.ch();
    if (ch === '\\' && s.i + 1 < s.len) { s.blank(s.i, ch); s.blank(s.i + 1, s.source[s.i + 1]); s.i += 2; return; }
    if (ch === '`') { s.emit(s.i, '`'); s.i += 1; s.popState(); return; }
    if (ch === '$' && s.next() === '{') {
        s.emit(s.i, '$'); s.emit(s.i + 1, '{'); s.i += 2;
        s.stack.push({ state: 'template', braceDepth: 0 });
        s.state = 'templateInterp'; s.braceDepth = 0;
        return;
    }
    s.blank(s.i, ch); s.i += 1;
}

export function stripTsNoise(source: string): string {
    const s = new StripState(source);
    while (s.i < s.len) {
        if (s.state === 'code' || s.state === 'templateInterp') { handleCodeOrInterp(s); }
        else if (s.state === 'lineComment') { handleLineComment(s); }
        else if (s.state === 'blockComment') { handleBlockComment(s); }
        else if (s.state === 'dquote') { handleStringLiteral(s, '"'); }
        else if (s.state === 'squote') { handleStringLiteral(s, "'"); }
        else if (s.state === 'template') { handleTemplate(s); }
        else { s.emit(s.i, s.ch()); s.i += 1; }
    }
    return s.out.join('');
}
