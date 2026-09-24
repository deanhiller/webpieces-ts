/**
 * The text `one-enum-spelling-in-api-lib` PRINTS: the enum to write, with real member names and
 * values, so the cure is an edit to paste rather than a direction to go and work one out (#1023).
 */
export class EnumText {
    /** `export enum SpeakerGender { FEMALE = 'female', MALE = 'male' }` */
    // webpieces-disable no-function-outside-class -- static formatter of this class
    static declaration(name: string, values: readonly string[]): string {
        const members = EnumText.members(values);
        return `export enum ${name} { ${members.map((m: EnumMemberText) => `${m.name} = '${m.value}'`).join(', ')} }`;
    }

    /** One member name per value, collision-free, in value order. */
    // webpieces-disable no-function-outside-class -- static formatter of this class
    static members(values: readonly string[]): EnumMemberText[] {
        const used = new Set<string>();
        return values.map((value: string) => {
            const base = EnumText.memberName(value);
            let name = base;
            for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
            used.add(name);
            return new EnumMemberText(name, value);
        });
    }

    /** `'randomWithChirp'` → `RANDOM_WITH_CHIRP`, `'en-US'` → `EN_US`, `'1x'` → `V_1X`. */
    // webpieces-disable no-function-outside-class -- static formatter of this class
    static memberName(value: string): string {
        const words = EnumText.words(value).map((word: string) => word.toUpperCase());
        const joined = words.join('_') || 'EMPTY';
        return /^[0-9]/.test(joined) ? `V_${joined}` : joined;
    }

    /** The member name of `name` in `enumName`, as a value would be spelled: `SpeakerGender.FEMALE`. */
    // webpieces-disable no-function-outside-class -- static formatter of this class
    static memberRef(enumName: string, value: string, all: readonly string[]): string {
        const member = EnumText.members(all).find((m: EnumMemberText) => m.value === value);
        return `${enumName}.${member?.name ?? EnumText.memberName(value)}`;
    }

    /** `SPEAKER_GENDERS` → `SpeakerGender`, `kind` → `Kind`, `voiceMode` → `VoiceMode`. */
    // webpieces-disable no-function-outside-class -- static formatter of this class
    static pascal(text: string): string {
        return EnumText.words(text).map((word: string) => word[0]!.toUpperCase() + word.slice(1).toLowerCase()).join('');
    }

    /** A list constant's singular type name: `SPEAKER_GENDERS` → `SpeakerGender`. */
    // webpieces-disable no-function-outside-class -- static formatter of this class
    static singularPascal(text: string): string {
        const pascal = EnumText.pascal(text);
        return pascal.length > 1 && pascal.endsWith('s') && !pascal.endsWith('ss') ? pascal.slice(0, -1) : pascal;
    }

    /** An uninitialised member's suggested wire value: `RANDOM_WITH_CHIRP` → `randomWithChirp`, `Red` → `red`. */
    // webpieces-disable no-function-outside-class -- static formatter of this class
    static valueFor(memberName: string): string {
        const pascal = EnumText.pascal(memberName);
        return pascal === '' ? memberName : pascal[0]!.toLowerCase() + pascal.slice(1);
    }

    // webpieces-disable no-function-outside-class -- private static splitter of this class
    private static words(text: string): string[] {
        return text
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .split(/[^A-Za-z0-9]+/)
            .filter((word: string) => word !== '');
    }
}

/** One enum member as printed. Data-only. */
export class EnumMemberText {
    constructor(
        readonly name: string,
        readonly value: string,
    ) {}
}
