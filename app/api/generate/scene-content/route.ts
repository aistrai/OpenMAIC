/**
 * Scene Content Generation API
 *
 * Generates scene content (slides/quiz/interactive/pbl) from an outline.
 * This is the first half of the two-step scene generation pipeline.
 * Does NOT generate actions. Use /api/generate/scene-actions for that.
 */

import { after, NextRequest } from 'next/server';
import { nanoid } from 'nanoid';
import { callLLM } from '@/lib/ai/llm';
import {
  applyOutlineFallbacks,
  generateSceneContent,
  buildVisionUserContent,
} from '@/lib/generation/generation-pipeline';
import type { AgentInfo } from '@/lib/generation/generation-pipeline';
import type { SceneOutline, PdfImage, ImageMapping } from '@/lib/types/generation';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import {
  createSceneContentGenerationJob,
  markSceneContentGenerationJobFailed,
  markSceneContentGenerationJobRunning,
  markSceneContentGenerationJobSucceeded,
} from '@/lib/server/scene-content-job-store';

const log = createLogger('Scene Content API');

export const maxDuration = 300;
const SCENE_CONTENT_JOB_HEADER = 'x-scene-content-job';
const SCENE_CONTENT_POLL_INTERVAL_MS = 2500;

type ResolvedSceneModel = ReturnType<typeof resolveModelFromHeaders>;

function shouldUseAsyncJob(req: NextRequest): boolean {
  const rawValue = req.headers.get(SCENE_CONTENT_JOB_HEADER);
  if (!rawValue) return false;
  const normalized = rawValue.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

async function runSceneContentGeneration(params: {
  effectiveOutline: SceneOutline;
  assignedImages?: PdfImage[];
  imageMapping?: ImageMapping;
  agents?: AgentInfo[];
  modelContext: ResolvedSceneModel;
}): Promise<unknown> {
  const { effectiveOutline, assignedImages, imageMapping, agents, modelContext } = params;
  const { model: languageModel, modelInfo } = modelContext;
  const hasVision = !!modelInfo?.capabilities?.vision;

  const aiCall = async (
    systemPrompt: string,
    userPrompt: string,
    images?: Array<{ id: string; src: string }>,
  ): Promise<string> => {
    if (images?.length && hasVision) {
      const result = await callLLM(
        {
          model: languageModel,
          system: systemPrompt,
          messages: [
            {
              role: 'user' as const,
              content: buildVisionUserContent(userPrompt, images),
            },
          ],
          maxOutputTokens: modelInfo?.outputWindow,
        },
        'scene-content',
      );
      return result.text;
    }

    const result = await callLLM(
      {
        model: languageModel,
        system: systemPrompt,
        prompt: userPrompt,
        maxOutputTokens: modelInfo?.outputWindow,
      },
      'scene-content',
    );
    return result.text;
  };

  // Media generation is handled client-side in parallel (media-orchestrator.ts).
  // Placeholder IDs (gen_img_1, gen_vid_1) should be preserved in generated elements.
  const generatedMediaMapping: ImageMapping = {};

  return generateSceneContent(
    effectiveOutline,
    aiCall,
    assignedImages,
    imageMapping,
    effectiveOutline.type === 'pbl' ? languageModel : undefined,
    hasVision,
    generatedMediaMapping,
    agents,
  );
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      outline: rawOutline,
      allOutlines,
      pdfImages,
      imageMapping,
      stageInfo,
      stageId,
      agents,
    } = body as {
      outline: SceneOutline;
      allOutlines: SceneOutline[];
      pdfImages?: PdfImage[];
      imageMapping?: ImageMapping;
      stageInfo: {
        name: string;
        description?: string;
        language?: string;
        style?: string;
      };
      stageId: string;
      agents?: AgentInfo[];
    };

    if (!rawOutline) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'outline is required');
    }
    if (!allOutlines || allOutlines.length === 0) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'allOutlines is required and must not be empty',
      );
    }
    if (!stageId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
    }

    const outline: SceneOutline = {
      ...rawOutline,
      language: rawOutline.language || (stageInfo?.language as 'zh-CN' | 'en-US') || 'zh-CN',
    };

    const modelContext = resolveModelFromHeaders(req);
    const { modelString } = modelContext;

    const effectiveOutline = applyOutlineFallbacks(outline, !!modelContext.model);

    let assignedImages: PdfImage[] | undefined;
    if (
      pdfImages &&
      pdfImages.length > 0 &&
      effectiveOutline.suggestedImageIds &&
      effectiveOutline.suggestedImageIds.length > 0
    ) {
      const suggestedIds = new Set(effectiveOutline.suggestedImageIds);
      assignedImages = pdfImages.filter((img) => suggestedIds.has(img.id));
    }

    if (shouldUseAsyncJob(req)) {
      const jobId = nanoid(10);
      const baseUrl = buildRequestOrigin(req);
      const pollUrl = `${baseUrl}/api/generate/scene-content/${jobId}`;

      const job = await createSceneContentGenerationJob(jobId, {
        stageId,
        outlineId: effectiveOutline.id,
        outlineTitle: effectiveOutline.title,
        outlineType: effectiveOutline.type,
        model: modelString,
      });

      after(async () => {
        try {
          await markSceneContentGenerationJobRunning(jobId);
          log.info(
            `[job=${jobId}] Generating content: "${effectiveOutline.title}" (${effectiveOutline.type}) [model=${modelString}]`,
          );

          const content = await runSceneContentGeneration({
            effectiveOutline,
            assignedImages,
            imageMapping,
            agents,
            modelContext,
          });

          if (!content) {
            throw new Error(`Failed to generate content: ${effectiveOutline.title}`);
          }

          await markSceneContentGenerationJobSucceeded(jobId, { content, effectiveOutline });
          log.info(`[job=${jobId}] Content generated successfully: "${effectiveOutline.title}"`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.error(`[job=${jobId}] Scene content generation failed:`, error);
          try {
            await markSceneContentGenerationJobFailed(jobId, message);
          } catch (markFailedError) {
            log.error(`[job=${jobId}] Failed to persist failed status:`, markFailedError);
          }
        }
      });

      return apiSuccess(
        {
          jobId,
          status: job.status,
          progress: job.progress,
          message: job.message,
          pollUrl,
          pollIntervalMs: SCENE_CONTENT_POLL_INTERVAL_MS,
          done: false,
        },
        202,
      );
    }

    log.info(
      `Generating content: "${effectiveOutline.title}" (${effectiveOutline.type}) [model=${modelString}]`,
    );

    const content = await runSceneContentGeneration({
      effectiveOutline,
      assignedImages,
      imageMapping,
      agents,
      modelContext,
    });

    if (!content) {
      log.error(`Failed to generate content for: "${effectiveOutline.title}"`);
      return apiError(
        'GENERATION_FAILED',
        500,
        `Failed to generate content: ${effectiveOutline.title}`,
      );
    }

    log.info(`Content generated successfully: "${effectiveOutline.title}"`);
    return apiSuccess({ content, effectiveOutline });
  } catch (error) {
    log.error('Scene content generation error:', error);
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
