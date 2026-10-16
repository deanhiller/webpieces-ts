import { WpAuthorization, AuthorizationType } from '@webpieces/core-util';
/* eslint-disable */
/**
 * STRING ENUMS in every position a type can appear, and union DISCRIMINATORS whose value on one
 * branch is a union (#1023): of enum members, and of string literals.
 */
import { ApiPath, Endpoint, POST, READ, RPC, WpAuthPublic } from '@webpieces/core-util';

/** Who is speaking. */
export enum SpeakerGender {
    FEMALE = 'female',
    MALE = 'male',
}

/** How a story's voice is chosen. */
export enum VoiceMode {
    RANDOM = 'random',
    RANDOM_WITH_CHIRP = 'randomWithChirp',
    RANDOM_CHIRP_MALE = 'randomChirpMale',
    FIXED = 'fixed',
}

/** One voice in a story. */
export interface Speaker {
    /** The speaker's gender. */
    gender: SpeakerGender;
}

/** A voice picked at random. */
export interface RandomStoryVoice {
    mode: VoiceMode.RANDOM;
}

/** A voice picked at random from the Chirp voices. */
export interface ChirpRandomVoice {
    mode: VoiceMode.RANDOM_WITH_CHIRP | VoiceMode.RANDOM_CHIRP_MALE;
}

/** One named voice, every time. */
export interface FixedStoryVoice {
    mode: VoiceMode.FIXED;
    name: string;
}

/** Narrowed on `mode`. */
export type StoryVoiceChoice = RandomStoryVoice | ChirpRandomVoice | FixedStoryVoice;

/** A random voice of one gender, chosen by a literal. */
export interface LiteralRandomVoice {
    kind: 'randomFemale' | 'randomMale';
}

/** One named voice, chosen by a literal. */
export interface LiteralFixedVoice {
    kind: 'fixed';
    name: string;
}

/** Narrowed on `kind`, one branch holding two literals. */
export type LiteralVoiceChoice = LiteralRandomVoice | LiteralFixedVoice;

/** The story to write and who narrates it. */
export interface StoryRequest {
    gender: SpeakerGender;
    rotation: SpeakerGender[];
    byCharacter: Record<string, SpeakerGender>;
    narrator: Speaker;
    only: VoiceMode.FIXED;
    voice?: StoryVoiceChoice;
    literalVoice?: LiteralVoiceChoice;
}

/** The story as written. */
export interface StoryResponse {
    gender: SpeakerGender;
    /** Not chosen yet: a NULLABLE named enum (#1197). */
    chosenGender: SpeakerGender | null;
    /** Not chosen yet: a NULLABLE string-literal union, rendered inline (#1197). */
    tone: 'calm' | 'loud' | null;
}

/** Stories. */
@ApiPath('/stories')
export class EnumsApi {
    /**
     * Writes one story.
     *
     * @summary Write a story
     * @returns The written story's voice choices.
     */
    @Endpoint(POST, '/write', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    write(request: StoryRequest): Promise<StoryResponse> {
        throw new Error('contract');
    }
}
