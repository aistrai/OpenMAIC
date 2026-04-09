import type { TTSVoiceInfo } from '@/lib/audio/types';

export async function fetchFishVoicesFromServer(params?: {
  apiKey?: string;
  baseUrl?: string;
  selfOnly?: boolean;
}): Promise<TTSVoiceInfo[]> {
  const payload: Record<string, unknown> = {};
  if (params?.apiKey?.trim()) payload.apiKey = params.apiKey.trim();
  if (params?.baseUrl?.trim()) payload.baseUrl = params.baseUrl.trim();
  if (params?.selfOnly) {
    payload.selfOnly = true;
  }

  const response = await fetch('/api/fish-voices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = (await response.json().catch(() => null)) as
    | { success?: boolean; voices?: TTSVoiceInfo[]; error?: string; details?: string }
    | null;

  if (!response.ok || !data?.success || !Array.isArray(data.voices)) {
    const reason = data?.details || data?.error || `HTTP ${response.status}`;
    throw new Error(reason);
  }

  return data.voices;
}
