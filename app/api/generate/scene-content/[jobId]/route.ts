import { type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  isValidSceneContentJobId,
  readSceneContentGenerationJob,
} from '@/lib/server/scene-content-job-store';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await context.params;

    if (!isValidSceneContentJobId(jobId)) {
      return apiError('INVALID_REQUEST', 400, 'Invalid scene content generation job id');
    }

    const job = await readSceneContentGenerationJob(jobId);
    if (!job) {
      return apiError('INVALID_REQUEST', 404, 'Scene content generation job not found');
    }

    const pollUrl = `${buildRequestOrigin(req)}/api/generate/scene-content/${jobId}`;
    const done = job.status === 'succeeded' || job.status === 'failed';

    return apiSuccess({
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      message: job.message,
      pollUrl,
      pollIntervalMs: 2500,
      requestSummary: job.requestSummary,
      result: job.result,
      error: job.error,
      done,
    });
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to retrieve scene content generation job',
      error instanceof Error ? error.message : String(error),
    );
  }
}
