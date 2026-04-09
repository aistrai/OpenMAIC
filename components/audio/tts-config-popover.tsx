'use client';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Volume2, Play, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { useFishVoicesStore } from '@/lib/store/fish-voices';
import { getTTSVoices } from '@/lib/audio/constants';
import { filterFishVoices, type FishVoiceLanguageFilter } from '@/lib/audio/fish-voice-utils';
import { useTTSPreview } from '@/lib/audio/use-tts-preview';
import { fetchFishVoicesFromServer } from '@/lib/audio/fish-voices-client';

/** Extract the English name from voice name format "ChineseName (English)" */
function getVoiceDisplayName(name: string, lang: string): string {
  if (lang === 'en-US') {
    const match = name.match(/\(([^)]+)\)/);
    return match ? match[1] : name;
  }
  return name;
}

export function TtsConfigPopover() {
  const { t, locale } = useI18n();
  const fishZhEnLabel = 'zh + en (Default)';
  const [open, setOpen] = useState(false);
  const { previewing, startPreview, stopPreview } = useTTSPreview();

  const ttsEnabled = useSettingsStore((s) => s.ttsEnabled);
  const setTTSEnabled = useSettingsStore((s) => s.setTTSEnabled);
  const ttsProviderId = useSettingsStore((s) => s.ttsProviderId);
  const ttsVoice = useSettingsStore((s) => s.ttsVoice);
  const ttsSpeed = useSettingsStore((s) => s.ttsSpeed);
  const ttsProvidersConfig = useSettingsStore((s) => s.ttsProvidersConfig);
  const setTTSVoice = useSettingsStore((s) => s.setTTSVoice);
  const fishVoices = useFishVoicesStore((s) => s.fishVoices);
  const setFishVoices = useFishVoicesStore((s) => s.setFishVoices);
  const [fishLanguageFilter, setFishLanguageFilter] = useState<FishVoiceLanguageFilter>('zh-en');
  const [loadingFishVoices, setLoadingFishVoices] = useState(false);
  const fishAutoFetchAttemptedRef = useRef(false);

  const filteredFishVoices = useMemo(
    () => filterFishVoices(fishVoices, { languageFilter: fishLanguageFilter }),
    [fishLanguageFilter, fishVoices],
  );

  const voices = useMemo(
    () => (ttsProviderId === 'fish-audio-tts' ? filteredFishVoices : getTTSVoices(ttsProviderId)),
    [filteredFishVoices, ttsProviderId],
  );
  const localizedVoices = useMemo(
    () =>
      voices.map((v) => ({
        ...v,
        displayName: getVoiceDisplayName(v.name, locale),
      })),
    [voices, locale],
  );

  const fetchFishVoices = useCallback(async () => {
    const fishConfig = ttsProvidersConfig['fish-audio-tts'];
    await fetchFishVoicesFromServer({
      apiKey: fishConfig?.apiKey,
      baseUrl: fishConfig?.baseUrl,
    }).then((list) => {
      setFishVoices(list);
    });
  }, [setFishVoices, ttsProvidersConfig]);

  useEffect(() => {
    if (!open) {
      fishAutoFetchAttemptedRef.current = false;
      return;
    }
    if (ttsProviderId !== 'fish-audio-tts') return;
    if (fishVoices.length > 1 || fishAutoFetchAttemptedRef.current || loadingFishVoices) return;

    fishAutoFetchAttemptedRef.current = true;
    setLoadingFishVoices(true);
    void fetchFishVoices()
      .catch((error) => {
        const message =
          error instanceof Error && error.message ? error.message : t('settings.fetchVoicesFailed');
        toast.error(`${t('settings.fetchVoicesFailed')}: ${message}`);
      })
      .finally(() => {
        setLoadingFishVoices(false);
      });
  }, [fetchFishVoices, fishVoices.length, loadingFishVoices, open, t, ttsProviderId]);

  useEffect(() => {
    if (ttsProviderId !== 'fish-audio-tts') return;
    if (!voices.some((voice) => voice.id === ttsVoice) && voices.length > 0) {
      setTTSVoice(voices[0].id);
    }
  }, [setTTSVoice, ttsProviderId, ttsVoice, voices]);

  const pillCls =
    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-all cursor-pointer select-none whitespace-nowrap border';

  const handlePreview = useCallback(async () => {
    if (previewing) {
      stopPreview();
      return;
    }
    try {
      const providerConfig = ttsProvidersConfig[ttsProviderId];
      await startPreview({
        text: t('settings.ttsTestTextDefault'),
        providerId: ttsProviderId,
        voice: ttsVoice,
        speed: ttsSpeed,
        apiKey: providerConfig?.apiKey,
        baseUrl: providerConfig?.baseUrl,
      });
    } catch (error) {
      const message =
        error instanceof Error && error.message ? error.message : t('settings.ttsTestFailed');
      toast.error(message);
    }
  }, [
    previewing,
    startPreview,
    stopPreview,
    t,
    ttsProviderId,
    ttsProvidersConfig,
    ttsSpeed,
    ttsVoice,
  ]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        stopPreview();
      }
      setOpen(nextOpen);
    },
    [stopPreview],
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              className={cn(
                pillCls,
                ttsEnabled
                  ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 border-emerald-200/60 dark:border-emerald-700/50'
                  : 'border-border/50 text-muted-foreground/70 hover:text-foreground hover:bg-muted/60',
              )}
            >
              <Volume2 className="size-3.5" />
              {ttsEnabled && (
                <span className="max-w-[60px] truncate">
                  {localizedVoices.find((v) => v.id === ttsVoice)?.displayName || ttsVoice}
                </span>
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('toolbar.ttsHint')}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-[280px] p-0">
        {/* Header with toggle */}
        <div className="flex items-center gap-2.5 px-3.5 py-3 border-b border-border/40">
          <Volume2
            className={cn(
              'size-4 shrink-0',
              ttsEnabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
            )}
          />
          <span
            className={cn('flex-1 text-sm font-medium', !ttsEnabled && 'text-muted-foreground')}
          >
            {t('toolbar.ttsTitle')}
          </span>
          <Switch
            checked={ttsEnabled}
            onCheckedChange={setTTSEnabled}
            className="scale-[0.85] origin-right"
          />
        </div>

        {/* Config body */}
        {ttsEnabled && (
          <div className="px-3.5 py-3 space-y-3">
            {ttsProviderId === 'fish-audio-tts' && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Select
                    value={fishLanguageFilter}
                    onValueChange={(value) => setFishLanguageFilter(value as FishVoiceLanguageFilter)}
                  >
                    <SelectTrigger className="h-7 text-xs flex-1 min-w-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="zh-en">{fishZhEnLabel}</SelectItem>
                      <SelectItem value="zh">zh only</SelectItem>
                      <SelectItem value="en">en only</SelectItem>
                      <SelectItem value="all">{t('settings.allLanguages')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {/* Voice + Preview row */}
            <div className="flex items-center gap-2">
              <Select value={ttsVoice} onValueChange={setTTSVoice}>
                <SelectTrigger className="h-7 text-xs flex-1 min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-[360px]">
                  {localizedVoices.map((v) => (
                    <SelectItem key={v.id} value={v.id} className="text-xs py-2">
                      <div className="min-w-0 space-y-1">
                        <div className="truncate">{v.displayName}</div>
                        {v.description && (
                          <div className="truncate text-[11px] text-muted-foreground">
                            {v.description}
                          </div>
                        )}
                        {v.tags?.length ? (
                          <div className="flex items-center gap-1 overflow-hidden">
                            {(v.tags || []).slice(0, 3).map((tag) => (
                              <span
                                key={`${v.id}-${tag}`}
                                className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <button
                onClick={handlePreview}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-all shrink-0',
                  previewing
                    ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300'
                    : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {previewing ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Play className="size-3" />
                )}
                {previewing ? t('toolbar.ttsPreviewing') : t('toolbar.ttsPreview')}
              </button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
