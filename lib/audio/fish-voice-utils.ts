import type { TTSVoiceInfo } from '@/lib/audio/types';

export type FishVoiceLanguageFilter = 'zh-en' | 'all';

const ZH_HINTS = ['zh', 'cn', 'chinese', 'mandarin', '中文', '普通话', '粤语', '國語', '国语'];
const EN_HINTS = ['en', 'english', '英语', '英文'];
const MULTILINGUAL_HINTS = ['multi', 'multilingual', 'bilingual', '多语', '多語'];

function hasAnyHint(input: string, hints: string[]): boolean {
  return hints.some((hint) => input.includes(hint));
}

function isMatchForZhEn(voice: TTSVoiceInfo): boolean {
  const normalized = `${voice.language || ''} ${voice.name || ''}`.toLowerCase();
  if (!normalized.trim()) return false;
  if (hasAnyHint(normalized, MULTILINGUAL_HINTS)) return true;
  return hasAnyHint(normalized, ZH_HINTS) || hasAnyHint(normalized, EN_HINTS);
}

export function filterFishVoices(
  voices: TTSVoiceInfo[],
  options: {
    languageFilter: FishVoiceLanguageFilter;
    selfOnly: boolean;
  },
): TTSVoiceInfo[] {
  return voices.filter((voice) => {
    if (voice.id === 'default') return true;

    if (options.selfOnly && !voice.self) {
      return false;
    }

    if (options.languageFilter === 'zh-en') {
      return isMatchForZhEn(voice);
    }

    return true;
  });
}
