/**
 * Single TTS Generation API
 *
 * Generates TTS audio for a single text string and returns base64-encoded audio.
 * Called by the client in parallel for each speech action after a scene is generated.
 *
 * POST /api/generate/tts
 */

import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { generateTTS } from '@/lib/audio/tts-providers';
import { resolveTTSApiKey, resolveTTSBaseUrl } from '@/lib/server/provider-config';
import type { TTSProviderId } from '@/lib/audio/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import {
  buildRequestOrigin,
  CLASSROOMS_DIR,
  isValidClassroomId,
} from '@/lib/server/classroom-storage';

const log = createLogger('TTS API');
const FORCED_TTS_PROVIDER: TTSProviderId = 'fish-audio-tts';

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { text, audioId, classroomId, ttsProviderId, ttsVoice, ttsSpeed, ttsApiKey, ttsBaseUrl } =
      body as {
        text: string;
        audioId: string;
        classroomId?: string;
        ttsProviderId: TTSProviderId;
        ttsVoice: string;
        ttsSpeed?: number;
        ttsApiKey?: string;
        ttsBaseUrl?: string;
      };
    const requestedProviderId = ttsProviderId;
    const providerId = FORCED_TTS_PROVIDER;
    const voice = requestedProviderId === providerId ? ttsVoice : 'default';

    // Validate required fields
    if (!text || !audioId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required fields: text, audioId');
    }

    if (requestedProviderId && requestedProviderId !== providerId) {
      log.warn(`TTS provider overridden to fixed provider: requested=${requestedProviderId}`);
    }

    const clientBaseUrl = ttsBaseUrl || undefined;
    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = clientBaseUrl
      ? ttsApiKey || ''
      : resolveTTSApiKey(providerId, ttsApiKey || undefined);
    const baseUrl = clientBaseUrl
      ? clientBaseUrl
      : resolveTTSBaseUrl(providerId, ttsBaseUrl || undefined);

    // Build TTS config
    const config = {
      providerId,
      voice: voice || 'default',
      speed: ttsSpeed ?? 1.0,
      apiKey,
      baseUrl,
    };

    log.info(
      `Generating TTS: provider=${providerId}, voice=${config.voice}, audioId=${audioId}, textLen=${text.length}`,
    );

    // Generate audio
    const { audio, format } = await generateTTS(config, text);
    let audioUrl: string | undefined;

    if (classroomId) {
      if (!isValidClassroomId(classroomId)) {
        return apiError('INVALID_REQUEST', 400, 'Invalid classroomId');
      }
      if (!isValidClassroomId(audioId)) {
        return apiError('INVALID_REQUEST', 400, 'Invalid audioId');
      }

      const audioDir = path.join(CLASSROOMS_DIR, classroomId, 'audio');
      await fs.mkdir(audioDir, { recursive: true });
      const filename = `${audioId}.${format}`;
      const filePath = path.join(audioDir, filename);
      const resolvedBase = path.resolve(CLASSROOMS_DIR, classroomId);
      const resolvedFile = path.resolve(filePath);
      if (!resolvedFile.startsWith(resolvedBase + path.sep)) {
        return apiError('INVALID_REQUEST', 400, 'Invalid audio path');
      }
      await fs.writeFile(filePath, audio);
      audioUrl = `${buildRequestOrigin(req)}/api/classroom-media/${classroomId}/audio/${filename}`;
    }

    // Convert to base64
    const base64 = Buffer.from(audio).toString('base64');

    return apiSuccess({ audioId, base64, format, ...(audioUrl ? { audioUrl } : {}) });
  } catch (error) {
    log.error('TTS generation error:', error);
    return apiError(
      'GENERATION_FAILED',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }
}
