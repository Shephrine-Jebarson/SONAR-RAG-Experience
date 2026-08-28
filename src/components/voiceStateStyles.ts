import { VoiceState } from '../types';

/** Single source of truth for how each voice state is presented.
 * Keeps colour + wording consistent across header, orb, and status copy. */
export const VOICE_STATE_COLOR: Record<VoiceState, string> = {
  idle: '#5c6474',
  listening: '#00e5ff',
  processing: '#a78bfa',
  speaking: '#ffb020',
  inactivity_countdown: '#ff5c5c',
  ended: '#5c6474'
};

export const VOICE_STATE_LABEL: Record<VoiceState, string> = {
  idle: 'Idle',
  listening: 'Listening',
  processing: 'Thinking',
  speaking: 'Speaking',
  inactivity_countdown: 'Ending soon',
  ended: 'Ended'
};

export const isLiveState = (s: VoiceState) =>
  s === 'listening' || s === 'processing' || s === 'speaking';
