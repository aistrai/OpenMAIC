import type { AgentInfo } from '@/lib/generation/generation-pipeline';
import type { SceneOutline, PdfImage, ImageMapping } from '@/lib/types/generation';
import { createLogger } from '@/lib/logger';

const log = createLogger('SceneContentClient');
const SCENE_CONTENT_JOB_HEADER = 'x-scene-content-job';
const DEFAULT_POLL_INTERVAL_MS = 2500;
const MAX_POLL_TIME_MS = 12 * 60 * 1000;

export interface SceneContentRequestParams {
  outline: SceneOutline;
  allOutlines: SceneOutline[];
  stageId: string;
  pdfImages?: PdfImage[];
  imageMapping?: ImageMapping;
  stageInfo: {
    name: string;
    description?: string;
    language?: string;
    style?: string;
  };
  agents?: AgentInfo[];
}

export interface SceneContentResult {
  success: boolean;
  content?: unknown;
  effectiveOutline?: SceneOutline;
  error?: string;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    if (signal?.aborted) {
      cleanup();
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function parseError(response: Response, fallback: string): Promise<string> {
  const data = await response.json().catch(() => ({ error: fallback }));
  return data.error || fallback;
}

export async function fetchSceneContentWithPolling(
  params: SceneContentRequestParams,
  headers: HeadersInit,
  signal?: AbortSignal,
): Promise<SceneContentResult> {
  const createResponse = await fetch('/api/generate/scene-content', {
    method: 'POST',
    headers: {
      ...headers,
      [SCENE_CONTENT_JOB_HEADER]: 'true',
    },
    body: JSON.stringify(params),
    signal,
  });

  if (!createResponse.ok) {
    return {
      success: false,
      error: await parseError(createResponse, `HTTP ${createResponse.status}`),
    };
  }

  const createData = await createResponse.json();

  // Backward-compatible fallback if server responds synchronously.
  if (createResponse.status !== 202) {
    if (!createData.success) {
      return {
        success: false,
        error: createData.error || 'Scene content generation failed',
      };
    }
    return createData as SceneContentResult;
  }

  const jobId = createData.jobId as string | undefined;
  if (!jobId) {
    return {
      success: false,
      error: 'Scene content generation job was created without a job id',
    };
  }

  const pollUrl =
    (createData.pollUrl as string | undefined) || `/api/generate/scene-content/${jobId}`;
  let pollIntervalMs = Number(createData.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + MAX_POLL_TIME_MS;

  while (Date.now() < deadline) {
    await delay(pollIntervalMs, signal);

    const pollResponse = await fetch(pollUrl, {
      method: 'GET',
      signal,
    });

    if (!pollResponse.ok) {
      return {
        success: false,
        error: await parseError(pollResponse, `HTTP ${pollResponse.status}`),
      };
    }

    const pollData = await pollResponse.json();
    if (!pollData.success) {
      return {
        success: false,
        error: pollData.error || 'Polling scene content job failed',
      };
    }

    if (pollData.done) {
      if (pollData.status === 'succeeded' && pollData.result) {
        return {
          success: true,
          content: pollData.result.content,
          effectiveOutline: pollData.result.effectiveOutline,
        };
      }
      return {
        success: false,
        error: pollData.error || 'Scene content generation failed',
      };
    }

    pollIntervalMs = Number(pollData.pollIntervalMs) || pollIntervalMs;
  }

  log.warn('Scene content polling exceeded timeout', { outlineId: params.outline.id });
  return {
    success: false,
    error: 'Scene content generation timed out while polling',
  };
}
