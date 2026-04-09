import type { TTSVoiceInfo } from '@/lib/audio/types';

export type FishVoiceLanguageFilter = 'zh' | 'en' | 'other';

function parseLanguageSignals(voice: TTSVoiceInfo): {
  isZh: boolean;
  isEn: boolean;
  isMulti: boolean;
} {
  const language = (voice.language || '').toLowerCase();
  const tokens = language.split(/[\s,;/|]+/).filter(Boolean);

  const isZh =
    tokens.some((token) =>
      token === 'zh' ||
      token.startsWith('zh-') ||
      token === 'cn' ||
      token === 'yue' ||
      token === 'wuu' ||
      token === 'mandarin' ||
      token === 'chinese',
    ) ||
    /[\u4e00-\u9fff]/.test(voice.name || '');

  const isEn =
    tokens.some((token) => token === 'en' || token.startsWith('en-') || token === 'english') ||
    /\benglish\b/i.test(voice.name || '');

  const isMulti =
    tokens.some((token) =>
      token.includes('multi') || token.includes('bilingual') || token.includes('polyglot'),
    ) ||
    /\b(multilingual|bilingual|multi-language)\b/i.test(voice.language || '');

  return { isZh, isEn, isMulti };
}

export function filterFishVoices(
  voices: TTSVoiceInfo[],
  options: {
    languageFilter: FishVoiceLanguageFilter;
  },
): TTSVoiceInfo[] {
  return voices.filter((voice) => {
    if (voice.id === 'default') return true;

    const { isZh, isEn, isMulti } = parseLanguageSignals(voice);

    if (options.languageFilter === 'zh') {
      return isZh && !isEn && !isMulti;
    }
    if (options.languageFilter === 'en') {
      return isEn && !isZh && !isMulti;
    }
    return isMulti || (isZh && isEn) || (!isZh && !isEn);
  });
}
