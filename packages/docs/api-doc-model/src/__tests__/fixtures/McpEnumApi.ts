import {
    ApiPath,
    ApiType,
    Endpoint,
    MCP,
    POST,
    READ,
    RPC,
    WpAuthJwt,
    WpMcpAuthJwt,
    WpMcpTool,
} from '@webpieces/core-util';

/**
 * STRING ENUMS in every position a type can appear, and union DISCRIMINATORS spelled with them
 * (#1023). The string enum is the ONE spelling of a fixed set of values in an API, so the generator
 * has to render it everywhere a `'a' | 'b'` union used to be.
 */

/** Who is speaking. */
export enum SpeakerGender {
    FEMALE = 'female',
    MALE = 'male',
}

/** How a story's voice is chosen. */
export enum VoiceMode {
    RANDOM = 'random',
    RANDOM_WITH_CHIRP = 'randomWithChirp',
    RANDOM_CHIRP_FEMALE = 'randomChirpFemale',
    RANDOM_CHIRP_MALE = 'randomChirpMale',
    FIXED = 'fixed',
}

/** One speaker. A string enum NESTED one DTO down. */
export interface Speaker {
    /** The speaker's gender. */
    gender: SpeakerGender;
}

/** Any voice at all. The discriminator is ONE enum member. */
export interface RandomStoryVoice {
    /** Discriminates this branch. */
    mode: VoiceMode.RANDOM;
}

/** A Chirp voice. The discriminator is a UNION of enum members, all mapping to this branch. */
export interface ChirpRandomVoice {
    /** Discriminates this branch. */
    mode: VoiceMode.RANDOM_WITH_CHIRP | VoiceMode.RANDOM_CHIRP_FEMALE | VoiceMode.RANDOM_CHIRP_MALE;
}

/** One named voice. */
export interface FixedStoryVoice {
    /** Discriminates this branch. */
    mode: VoiceMode.FIXED;

    /** The voice's name. */
    name: string;
}

/** Every way to choose a voice, narrowed on `mode` exactly as TypeScript narrows it. */
export type StoryVoiceChoice = RandomStoryVoice | ChirpRandomVoice | FixedStoryVoice;

/** A literal-union discriminator on one branch — the generator keeps supporting literals. */
export interface LiteralRandomVoice {
    /** Discriminates this branch. */
    kind: 'randomFemale' | 'randomMale';
}

/** The other literal branch. */
export interface LiteralFixedVoice {
    /** Discriminates this branch. */
    kind: 'fixed';

    /** The voice's name. */
    name: string;
}

/** Narrowed on `kind`, where one branch holds two literals. */
export type LiteralVoiceChoice = LiteralRandomVoice | LiteralFixedVoice;

/** Two branches that CLAIM the same value — TypeScript cannot narrow this, so neither may the document. */
export interface OverlapA {
    /** Overlaps with OverlapB. */
    tag: 'a' | 'shared';
}

/** The other overlapping branch. */
export interface OverlapB {
    /** Overlaps with OverlapA. */
    tag: 'b' | 'shared';
}

/** Not narrowable: `shared` is on both branches. */
export type OverlappingChoice = OverlapA | OverlapB;

/** Asks for a story. A string enum at the REQUEST ROOT's fields. */
export interface StoryRequest {
    /** The narrator's gender. */
    gender: SpeakerGender;

    /** Genders to rotate through. */
    rotation: SpeakerGender[];

    /** A gender per character name. */
    byCharacter: Record<string, SpeakerGender>;

    /** The narrator. */
    narrator: Speaker;

    /** One mode, as a single enum member. */
    only: VoiceMode.FIXED;

    /** Several modes, as a union of enum members. */
    someModes: VoiceMode.RANDOM | VoiceMode.FIXED;

    /** How the voice is chosen. */
    voice?: StoryVoiceChoice;

    /** How the voice is chosen, the literal spelling. */
    literalVoice?: LiteralVoiceChoice;
}

/** The story. A string enum at the RESPONSE ROOT's fields. */
export interface StoryResponse {
    /** The gender actually used. */
    gender: SpeakerGender;
}

/** Asks with a union no discriminator can be derived for. */
export interface OverlapRequest {
    /** Not narrowable. */
    choice: OverlappingChoice;
}

/** Stories, for the string-enum tests. */
@ApiType(MCP)
@ApiPath('/stories')
export abstract class McpEnumApi {
    /** Writes one story. */
    @WpMcpTool('write_story')
    @WpAuthJwt({ allRolesAllowed: true })
    @WpMcpAuthJwt({ allRolesAllowed: true })
    @Endpoint(POST, '/write', READ, RPC)
    writeStory(_request: StoryRequest): Promise<StoryResponse> {
        throw new Error('contract only');
    }

    /** Refused: its request holds a union TypeScript cannot narrow. */
    @WpMcpTool('overlap_story')
    @WpAuthJwt({ allRolesAllowed: true })
    @WpMcpAuthJwt({ allRolesAllowed: true })
    @Endpoint(POST, '/overlap', READ, RPC)
    overlap(_request: OverlapRequest): Promise<StoryResponse> {
        throw new Error('contract only');
    }
}
