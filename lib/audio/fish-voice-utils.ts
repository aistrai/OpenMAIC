import type { TTSVoiceInfo } from '@/lib/audio/types';

export type FishVoiceLanguageFilter = 'zh' | 'en' | 'other';

const ZH_HINTS = ['zh', 'cn', 'chinese', 'mandarin', '中文', '普通话', '粤语', '國語', '国语'];
const EN_HINTS = ['en', 'english', '英语', '英文'];
const MULTILINGUAL_HINTS = ['multi', 'multilingual', 'bilingual', '多语', '多語'];

function hasAnyHint(input: string, hints: string[]): boolean {
  return hints.some((hint) => input.includes(hint));
}

function buildSearchText(voice: TTSVoiceInfo): string {
  const tagsText = Array.isArray(voice.tags) ? voice.tags.join(' ') : '';
  return `${voice.language || ''} ${voice.name || ''} ${voice.description || ''} ${tagsText}`.toLowerCase();
}

function isMultilingual(input: string): boolean {
  return hasAnyHint(input, MULTILINGUAL_HINTS);
}

function isMatchZh(voice: TTSVoiceInfo): boolean {
  const normalized = buildSearchText(voice);
  if (!normalized.trim()) return false;
  return isMultilingual(normalized) || hasAnyHint(normalized, ZH_HINTS);
}

function isMatchEn(voice: TTSVoiceInfo): boolean {
  const normalized = buildSearchText(voice);
  if (!normalized.trim()) return false;
  return isMultilingual(normalized) || hasAnyHint(normalized, EN_HINTS);
}

export function filterFishVoices(
  voices: TTSVoiceInfo[],
  options: {
    languageFilter: FishVoiceLanguageFilter;
  },
): TTSVoiceInfo[] {
  return voices.filter((voice) => {
    if (voice.id === 'default') return true;
    const isZh = isMatchZh(voice);
    const isEn = isMatchEn(voice);

    // Keep categories mutually exclusive:
    // - Chinese only: zh=true, en=false
    // - English only: en=true, zh=false
    // - Other: overlap, multilingual, or no clear zh/en signal
    if (options.languageFilter === 'zh') return isZh && !isEn;
    if (options.languageFilter === 'en') return isEn && !isZh;
    return (isZh && isEn) || (!isZh && !isEn);
  });
}
