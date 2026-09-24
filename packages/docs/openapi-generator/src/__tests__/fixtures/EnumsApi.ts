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

export interface Speaker {
    /** The speaker's gender. */
    gender: SpeakerGender;
}

export interface RandomStoryVoice {
    mode: VoiceMode.RANDOM;
}

export interface ChirpRandomVoice {
    mode: VoiceMode.RANDOM_WITH_CHIRP | VoiceMode.RANDOM_CHIRP_MALE;
}

export interface FixedStoryVoice {
    mode: VoiceMode.FIXED;
    name: string;
}

/** Narrowed on `mode`. */
export type StoryVoiceChoice = RandomStoryVoice | ChirpRandomVoice | FixedStoryVoice;

export interface LiteralRandomVoice {
    kind: 'randomFemale' | 'randomMale';
}

export interface LiteralFixedVoice {
    kind: 'fixed';
    name: string;
}

/** Narrowed on `kind`, one branch holding two literals. */
export type LiteralVoiceChoice = LiteralRandomVoice | LiteralFixedVoice;

export interface StoryRequest {
    gender: SpeakerGender;
    rotation: SpeakerGender[];
    byCharacter: Record<string, SpeakerGender>;
    narrator: Speaker;
    only: VoiceMode.FIXED;
    voice?: StoryVoiceChoice;
    literalVoice?: LiteralVoiceChoice;
}

export interface StoryResponse {
    gender: SpeakerGender;
}

/** Stories. */
@ApiPath('/stories')
export class EnumsApi {
    /** Writes one story. */
    @Endpoint(POST, '/write', READ, RPC)
    @WpAuthPublic('Fixture only.')
    write(request: StoryRequest): Promise<StoryResponse> {
        throw new Error('contract');
    }
}
