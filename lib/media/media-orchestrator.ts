/**
 * Media Generation Orchestrator
 *
 * Dispatches media generation API calls for all mediaGenerations across outlines.
 * Runs entirely on the frontend — calls /api/generate/image and /api/generate/video,
 * fetches result blobs, stores in IndexedDB, and updates the Zustand store.
 */

import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useSettingsStore } from '@/lib/store/settings';
import { useStageStore } from '@/lib/store/stage';
import { db, mediaFileKey } from '@/lib/utils/database';
import type { SceneOutline } from '@/lib/types/generation';
import type { MediaGenerationRequest } from '@/lib/media/types';
import type { Scene } from '@/lib/types/stage';
import { createLogger } from '@/lib/logger';

const log = createLogger('MediaOrchestrator');

/** Error with a structured errorCode from the API */
class MediaApiError extends Error {
  errorCode?: string;
  constructor(message: string, errorCode?: string) {
    super(message);
    this.errorCode = errorCode;
  }
}

/**
 * Launch media generation for all mediaGenerations declared in outlines.
 * Runs in parallel with content/action generation — does not block.
 */
export async function generateMediaForOutlines(
  outlines: SceneOutline[],
  stageId: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  const settings = useSettingsStore.getState();
  const store = useMediaGenerationStore.getState();

  // Collect all media requests
  const allRequests: MediaGenerationRequest[] = [];
  for (const outline of outlines) {
    if (!outline.mediaGenerations) continue;
    for (const mg of outline.mediaGenerations) {
      // Filter by enabled flags
      if (mg.type === 'image' && !settings.imageGenerationEnabled) continue;
      if (mg.type === 'video' && !settings.videoGenerationEnabled) continue;
      // Skip already completed or permanently failed (restored from DB)
      const existing = store.getTask(mg.elementId);
      if (existing?.status === 'done' || existing?.status === 'failed') continue;
      allRequests.push(mg);
    }
  }

  if (allRequests.length === 0) return;

  // Enqueue all as pending
  useMediaGenerationStore.getState().enqueueTasks(stageId, allRequests);

  // Process requests serially — image/video APIs have limited concurrency
  for (const req of allRequests) {
    if (abortSignal?.aborted) break;
    await generateSingleMedia(req, stageId, abortSignal);
  }
}

/**
 * Retry a single failed media task.
 */
export async function retryMediaTask(elementId: string): Promise<void> {
  const store = useMediaGenerationStore.getState();
  const task = store.getTask(elementId);
  if (!task || task.status !== 'failed') return;

  // Check if the corresponding generation type is still enabled in global settings
  const settings = useSettingsStore.getState();
  if (task.type === 'image' && !settings.imageGenerationEnabled) {
    store.markFailed(elementId, 'Generation disabled', 'GENERATION_DISABLED');
    return;
  }
  if (task.type === 'video' && !settings.videoGenerationEnabled) {
    store.markFailed(elementId, 'Generation disabled', 'GENERATION_DISABLED');
    return;
  }

  // Remove persisted failure record from DB so a fresh result can be written
  const dbKey = mediaFileKey(task.stageId, elementId);
  await db.mediaFiles.delete(dbKey).catch(() => {});

  store.markPendingForRetry(elementId);
  await generateSingleMedia(
    {
      type: task.type,
      prompt: task.prompt,
      elementId: task.elementId,
      aspectRatio: task.params.aspectRatio as MediaGenerationRequest['aspectRatio'],
      style: task.params.style,
    },
    task.stageId,
  );
}

// ==================== Internal ====================

async function generateSingleMedia(
  req: MediaGenerationRequest,
  stageId: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  const store = useMediaGenerationStore.getState();
  store.markGenerating(req.elementId);

  try {
    let resultUrl: string;
    let posterUrl: string | undefined;
    let mimeType: string;

    if (req.type === 'image') {
      const result = await callImageApi(req, abortSignal);
      resultUrl = result.url;
      mimeType = 'image/png';
    } else {
      const result = await callVideoApi(req, abortSignal);
      resultUrl = result.url;
      posterUrl = result.poster;
      mimeType = 'video/mp4';
    }

    if (abortSignal?.aborted) return;

    // Fetch blob from URL
    const blob = await fetchAsBlob(resultUrl);
    const posterBlob = posterUrl ? await fetchAsBlob(posterUrl).catch(() => undefined) : undefined;

    // Store in IndexedDB
    await db.mediaFiles.put({
      id: mediaFileKey(stageId, req.elementId),
      stageId,
      type: req.type,
      blob,
      mimeType,
      size: blob.size,
      poster: posterBlob,
      prompt: req.prompt,
      params: JSON.stringify({
        aspectRatio: req.aspectRatio,
        style: req.style,
      }),
      createdAt: Date.now(),
    });

    // Update store with object URL
    const objectUrl = URL.createObjectURL(blob);
    const posterObjectUrl = posterBlob ? URL.createObjectURL(posterBlob) : undefined;
    useMediaGenerationStore.getState().markDone(req.elementId, objectUrl, posterObjectUrl);

    const persisted = await uploadClassroomMedia({
      stageId,
      elementId: req.elementId,
      type: req.type,
      blob,
      poster: posterBlob,
    }).catch((error) => {
      log.warn(`Failed to upload ${req.elementId} for sharing:`, error);
      return null;
    });

    if (persisted?.url) {
      await db.mediaFiles
        .update(mediaFileKey(stageId, req.elementId), {
          ossKey: persisted.url,
          posterOssKey: persisted.posterUrl,
        })
        .catch(() => {});
      replaceMediaPlaceholder(stageId, req.elementId, persisted.url, persisted.posterUrl);
    }
  } catch (err) {
    if (abortSignal?.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    const errorCode = err instanceof MediaApiError ? err.errorCode : undefined;
    log.error(`Failed ${req.elementId}:`, message);
    useMediaGenerationStore.getState().markFailed(req.elementId, message, errorCode);

    // Persist non-retryable failures to IndexedDB so they survive page refresh
    if (errorCode) {
      await db.mediaFiles
        .put({
          id: mediaFileKey(stageId, req.elementId),
          stageId,
          type: req.type,
          blob: new Blob(), // empty placeholder
          mimeType: req.type === 'image' ? 'image/png' : 'video/mp4',
          size: 0,
          prompt: req.prompt,
          params: JSON.stringify({
            aspectRatio: req.aspectRatio,
            style: req.style,
          }),
          error: message,
          errorCode,
          createdAt: Date.now(),
        })
        .catch(() => {}); // best-effort
    }
  }
}

export async function applyStoredMediaUrlsToScene(scene: Scene): Promise<Scene> {
  if (scene.content?.type !== 'slide') return scene;

  const hasPlaceholders = scene.content.canvas.elements.some(
    (element) =>
      (element.type === 'image' || element.type === 'video') &&
      typeof element.src === 'string' &&
      /^gen_(img|vid)_[\w-]+$/i.test(element.src),
  );

  if (!hasPlaceholders) return scene;

  const records = await db.mediaFiles
    .where('stageId')
    .equals(scene.stageId)
    .toArray()
    .catch(() => []);
  const urlByElementId = new Map(
    records
      .map((record) => {
        const elementId = record.id.includes(':')
          ? record.id.split(':').slice(1).join(':')
          : record.id;
        return [elementId, record] as const;
      })
      .filter(([, record]) => !!record.ossKey),
  );

  const nextScene: Scene = structuredClone(scene);
  if (nextScene.content.type !== 'slide') return scene;
  let changed = false;
  nextScene.content.canvas.elements = nextScene.content.canvas.elements.map((element) => {
    if ((element.type !== 'image' && element.type !== 'video') || typeof element.src !== 'string') {
      return element;
    }
    const record = urlByElementId.get(element.src);
    if (!record?.ossKey) return element;
    changed = true;
    return element.type === 'video' && record.posterOssKey
      ? { ...element, src: record.ossKey, poster: record.posterOssKey }
      : { ...element, src: record.ossKey };
  });

  return changed ? nextScene : scene;
}

async function uploadClassroomMedia(params: {
  stageId: string;
  elementId: string;
  type: 'image' | 'video';
  blob: Blob;
  poster?: Blob;
}): Promise<{ url: string; posterUrl?: string }> {
  const formData = new FormData();
  formData.append('classroomId', params.stageId);
  formData.append('elementId', params.elementId);
  formData.append('type', params.type);
  formData.append('file', params.blob, params.type === 'image' ? 'image.png' : 'video.mp4');
  if (params.poster) formData.append('poster', params.poster, 'poster.jpg');

  const response = await fetch('/api/classroom-media', {
    method: 'POST',
    body: formData,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error(data.error || `Media upload failed: HTTP ${response.status}`);
  }
  return { url: data.url, posterUrl: data.posterUrl };
}

function replaceMediaPlaceholder(
  stageId: string,
  elementId: string,
  url: string,
  posterUrl?: string,
): void {
  const stageStore = useStageStore.getState();
  const scenes = stageStore.scenes;
  const scene = scenes.find(
    (candidate) =>
      candidate.stageId === stageId &&
      candidate.content?.type === 'slide' &&
      candidate.content.canvas.elements.some(
        (element) =>
          (element.type === 'image' || element.type === 'video') && element.src === elementId,
      ),
  );
  if (!scene || scene.content.type !== 'slide') return;

  const nextScene: Scene = structuredClone(scene);
  if (nextScene.content.type !== 'slide') return;
  let changed = false;
  nextScene.content.canvas.elements = nextScene.content.canvas.elements.map((element) => {
    if ((element.type !== 'image' && element.type !== 'video') || element.src !== elementId) {
      return element;
    }
    changed = true;
    return element.type === 'video' && posterUrl
      ? { ...element, src: url, poster: posterUrl }
      : { ...element, src: url };
  });

  if (changed) {
    stageStore.updateScene(scene.id, {
      content: nextScene.content,
      updatedAt: Date.now(),
    });
  }
}

async function callImageApi(
  req: MediaGenerationRequest,
  abortSignal?: AbortSignal,
): Promise<{ url: string }> {
  const settings = useSettingsStore.getState();
  const providerConfig = settings.imageProvidersConfig?.[settings.imageProviderId];

  const response = await fetch('/api/generate/image', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-image-provider': settings.imageProviderId || '',
      'x-image-model': settings.imageModelId || '',
      'x-api-key': providerConfig?.apiKey || '',
      'x-base-url': providerConfig?.baseUrl || '',
    },
    body: JSON.stringify({
      prompt: req.prompt,
      aspectRatio: req.aspectRatio,
      style: req.style,
    }),
    signal: abortSignal,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new MediaApiError(data.error || `Image API returned ${response.status}`, data.errorCode);
  }

  const data = await response.json();
  if (!data.success)
    throw new MediaApiError(data.error || 'Image generation failed', data.errorCode);

  // Result may have url or base64
  const url =
    data.result?.url || (data.result?.base64 ? `data:image/png;base64,${data.result.base64}` : '');
  if (!url) throw new Error('No image URL in response');
  return { url };
}

async function callVideoApi(
  req: MediaGenerationRequest,
  abortSignal?: AbortSignal,
): Promise<{ url: string; poster?: string }> {
  const settings = useSettingsStore.getState();
  const providerConfig = settings.videoProvidersConfig?.[settings.videoProviderId];

  const response = await fetch('/api/generate/video', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-video-provider': settings.videoProviderId || '',
      'x-video-model': settings.videoModelId || '',
      'x-api-key': providerConfig?.apiKey || '',
      'x-base-url': providerConfig?.baseUrl || '',
    },
    body: JSON.stringify({
      prompt: req.prompt,
      aspectRatio: req.aspectRatio,
    }),
    signal: abortSignal,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new MediaApiError(data.error || `Video API returned ${response.status}`, data.errorCode);
  }

  const data = await response.json();
  if (!data.success)
    throw new MediaApiError(data.error || 'Video generation failed', data.errorCode);

  const url = data.result?.url;
  if (!url) throw new Error('No video URL in response');
  return { url, poster: data.result?.poster };
}

async function fetchAsBlob(url: string): Promise<Blob> {
  // For data URLs, convert directly
  if (url.startsWith('data:')) {
    const res = await fetch(url);
    return res.blob();
  }
  // For remote URLs, proxy through our server to bypass CORS restrictions
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const res = await fetch('/api/proxy-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Proxy fetch failed: ${res.status}`);
    }
    return res.blob();
  }
  // Relative URLs (shouldn't happen, but handle gracefully)
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch blob: ${res.status}`);
  return res.blob();
}
