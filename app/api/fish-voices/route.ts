import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { proxyFetch } from '@/lib/server/proxy-fetch';
import { resolveTTSApiKey, resolveTTSBaseUrl } from '@/lib/server/provider-config';
import type { TTSVoiceInfo } from '@/lib/audio/types';
import { TTS_PROVIDERS } from '@/lib/audio/constants';

const log = createLogger('FishVoices');

export const maxDuration = 30;

interface FishModelItem {
  _id?: string;
  title?: string;
  description?: string;
  type?: string;
  tags?: string[];
  self?: boolean;
  is_self?: boolean;
  languages?: string[];
  language?: string;
}

function resolveFishModelEndpoint(baseUrl: string, selfOnly: boolean): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  const root = normalized.endsWith('/v1') ? normalized.slice(0, -3) : normalized;
  const url = new URL(`${root}/model`);
  url.searchParams.set('page_size', '100');
  url.searchParams.set('sort_by', 'score');
  if (selfOnly) {
    url.searchParams.set('self', 'true');
  }
  return url.toString();
}

function normalizeFishVoices(items: FishModelItem[]): TTSVoiceInfo[] {
  const result: TTSVoiceInfo[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const id = item?._id?.trim();
    if (!id || seen.has(id)) continue;

    // SVC models are for voice conversion, not TTS generation.
    if (item.type?.toLowerCase() === 'svc') continue;

    const language =
      (Array.isArray(item.languages) ? item.languages.find((v) => !!v?.trim()) : undefined) ||
      item.language ||
      'multilingual';

    result.push({
      id,
      name: item.title?.trim() || id,
      language,
      gender: 'neutral',
      description: item.description?.trim() || undefined,
      tags: Array.isArray(item.tags)
        ? item.tags
            .filter((tag): tag is string => typeof tag === 'string')
            .map((tag) => tag.trim())
            .filter((tag) => !!tag)
        : undefined,
      self: item.self ?? item.is_self ?? false,
    });
    seen.add(id);
  }

  return result;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { apiKey, baseUrl } = body as {
      apiKey?: string;
      baseUrl?: string;
      selfOnly?: boolean;
    };
    const selfOnly = body?.selfOnly === true;

    const clientBaseUrl = baseUrl?.trim() || undefined;
    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const resolvedApiKey = resolveTTSApiKey('fish-audio-tts', apiKey?.trim() || undefined);
    if (!resolvedApiKey) {
      return apiError('MISSING_API_KEY', 400, 'Fish Audio API key is required');
    }

    const resolvedBaseUrl =
      clientBaseUrl ||
      resolveTTSBaseUrl('fish-audio-tts') ||
      TTS_PROVIDERS['fish-audio-tts'].defaultBaseUrl;

    if (!resolvedBaseUrl) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Fish Audio base URL is required');
    }

    const endpoint = resolveFishModelEndpoint(resolvedBaseUrl, selfOnly);

    const response = await proxyFetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${resolvedApiKey}`,
      },
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      return apiError('REDIRECT_NOT_ALLOWED', 403, 'Redirects are not allowed');
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      return apiError(
        'UPSTREAM_ERROR',
        response.status,
        'Failed to fetch voices from Fish Audio',
        errorText || response.statusText,
      );
    }

    const payload = (await response.json()) as { items?: FishModelItem[] };
    let voices = normalizeFishVoices(Array.isArray(payload.items) ? payload.items : []);
    if (selfOnly) {
      voices = voices.filter((voice) => voice.self);
    }

    return apiSuccess({ voices });
  } catch (error) {
    log.error('Failed to fetch Fish Audio voices:', error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to fetch Fish Audio voices',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
