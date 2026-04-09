import { create } from 'zustand';
import type { TTSVoiceInfo } from '@/lib/audio/types';
import { getTTSVoices } from '@/lib/audio/constants';

const defaultFishVoice = getTTSVoices('fish-audio-tts')[0] || {
  id: 'default',
  name: 'Default',
  language: 'multilingual',
  gender: 'neutral' as const,
};

function normalizeFishVoices(voices: TTSVoiceInfo[]): TTSVoiceInfo[] {
  const seen = new Set<string>();
  const normalized: TTSVoiceInfo[] = [];

  for (const voice of voices) {
    const id = voice.id?.trim();
    if (!id || seen.has(id)) continue;
    normalized.push({
      id,
      name: voice.name || id,
      language: voice.language || 'multilingual',
      gender: voice.gender || 'neutral',
      description: voice.description,
      tags: Array.isArray(voice.tags) ? voice.tags.filter((tag) => !!tag) : undefined,
      self: voice.self ?? false,
    });
    seen.add(id);
  }

  if (!seen.has(defaultFishVoice.id)) {
    normalized.unshift(defaultFishVoice);
  } else {
    const idx = normalized.findIndex((v) => v.id === defaultFishVoice.id);
    if (idx > 0) {
      const [d] = normalized.splice(idx, 1);
      normalized.unshift(d);
    }
  }

  return normalized;
}

interface FishVoicesState {
  fishVoices: TTSVoiceInfo[];
  setFishVoices: (voices: TTSVoiceInfo[]) => void;
  resetFishVoices: () => void;
}

export const useFishVoicesStore = create<FishVoicesState>()((set) => ({
  fishVoices: [defaultFishVoice],
  setFishVoices: (voices) => set({ fishVoices: normalizeFishVoices(voices) }),
  resetFishVoices: () => set({ fishVoices: [defaultFishVoice] }),
}));
