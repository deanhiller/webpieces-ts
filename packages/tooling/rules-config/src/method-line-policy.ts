/** The two existing method-size disable directives, including the modified-method expiry. */
export class MethodDisable {
    constructor(readonly type: 'full' | 'new-only' | 'none', readonly isExpired: boolean, readonly date: string | undefined) {}
}

/** Shared interpretation of method-size exemptions, independent of git, Nx and disk. */
export class MethodLinePolicy {
    disableInfo(lines: readonly string[], lineNumber: number): MethodDisable {
        for (let i = lineNumber - 2; i >= Math.max(0, lineNumber - 5); i--) {
            const line = lines[i]?.trim() ?? '';
            if (line.startsWith('function ') || line.startsWith('class ') || line.endsWith('}')) break;
            if (!line.includes('webpieces-disable')) continue;
            const type = line.includes('max-lines-modified') ? 'full'
                : line.includes('max-lines-new-methods') ? 'new-only' : 'none';
            if (type === 'none') continue;
            const match = line.match(/max-lines-(?:modified|new-methods)\s+(\d{4}\/\d{2}\/\d{2}|XXXX\/XX\/XX)/);
            const date = match?.[1];
            return new MethodDisable(type, !date || !this.validDate(date), date);
        }
        return new MethodDisable('none', false, undefined);
    }

    /** New-method validation historically accepts either directive without a date. */
    hasNewDisable(lines: readonly string[], lineNumber: number): boolean {
        for (let i = lineNumber - 2; i >= Math.max(0, lineNumber - 5); i--) {
            const line = lines[i]?.trim() ?? '';
            if (line.startsWith('function ') || line.startsWith('class ') || line.endsWith('}')) break;
            if (line.includes('webpieces-disable') && (line.includes('max-lines-new-methods') || line.includes('max-lines-modified'))) return true;
        }
        return false;
    }

    /** A new-only exemption must still pass the modified-method limit unless a full exemption exists. */
    permits(lines: readonly string[], line: number, isNew: boolean, disableAllowed: boolean, checkModified: boolean): boolean {
        if (!disableAllowed) return false;
        if (isNew && !checkModified) return this.hasNewDisable(lines, line);
        const disable = this.disableInfo(lines, line);
        if (disable.type === 'full' && !disable.isExpired) return true;
        return false;
    }

    private validDate(raw: string): boolean {
        if (raw === 'XXXX/XX/XX') return true;
        const parts = raw.split('/').map(Number);
        const date = new Date(parts[0], parts[1] - 1, parts[2]);
        if (date.getFullYear() !== parts[0] || date.getMonth() !== parts[1] - 1 || date.getDate() !== parts[2]) return false;
        const now = new Date();
        return date >= new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
    }
}
