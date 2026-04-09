import { promises as fs } from 'fs';
import path from 'path';
import type { SceneOutline } from '@/lib/types/generation';
import {
  SCENE_CONTENT_JOBS_DIR,
  ensureSceneContentJobsDir,
  writeJsonFileAtomic,
} from '@/lib/server/classroom-storage';

export type SceneContentGenerationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface SceneContentGenerationJob {
  id: string;
  status: SceneContentGenerationJobStatus;
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  requestSummary: {
    stageId: string;
    outlineId: string;
    outlineTitle: string;
    outlineType: string;
    model: string;
  };
  result?: {
    content: unknown;
    effectiveOutline: SceneOutline;
  };
  error?: string;
}

function jobFilePath(jobId: string) {
  return path.join(SCENE_CONTENT_JOBS_DIR, `${jobId}.json`);
}

const jobLocks = new Map<string, Promise<void>>();

async function withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const prev = jobLocks.get(jobId) ?? Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>((r) => {
    resolve = r;
  });
  jobLocks.set(jobId, next);
  try {
    await prev;
    return await fn();
  } finally {
    resolve!();
    if (jobLocks.get(jobId) === next) {
      jobLocks.delete(jobId);
    }
  }
}

const STALE_JOB_TIMEOUT_MS = 30 * 60 * 1000;

function markStaleIfNeeded(job: SceneContentGenerationJob): SceneContentGenerationJob {
  if (job.status !== 'running') return job;
  const updatedAt = new Date(job.updatedAt).getTime();
  if (Date.now() - updatedAt > STALE_JOB_TIMEOUT_MS) {
    return {
      ...job,
      status: 'failed',
      message: 'Job appears stale (no progress update for 30 minutes)',
      error: 'Stale job: process may have restarted during generation',
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  return job;
}

export function isValidSceneContentJobId(jobId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(jobId);
}

export async function createSceneContentGenerationJob(
  jobId: string,
  summary: SceneContentGenerationJob['requestSummary'],
): Promise<SceneContentGenerationJob> {
  const now = new Date().toISOString();
  const job: SceneContentGenerationJob = {
    id: jobId,
    status: 'queued',
    progress: 0,
    message: 'Scene content generation job queued',
    createdAt: now,
    updatedAt: now,
    requestSummary: summary,
  };

  await ensureSceneContentJobsDir();
  await writeJsonFileAtomic(jobFilePath(jobId), job);
  return job;
}

export async function readSceneContentGenerationJob(
  jobId: string,
): Promise<SceneContentGenerationJob | null> {
  try {
    const content = await fs.readFile(jobFilePath(jobId), 'utf-8');
    const job = JSON.parse(content) as SceneContentGenerationJob;
    return markStaleIfNeeded(job);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function updateSceneContentGenerationJob(
  jobId: string,
  patch: Partial<SceneContentGenerationJob>,
): Promise<SceneContentGenerationJob> {
  return withJobLock(jobId, async () => {
    const existing = await readSceneContentGenerationJob(jobId);
    if (!existing) {
      throw new Error(`Scene content generation job not found: ${jobId}`);
    }

    const updated: SceneContentGenerationJob = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    await writeJsonFileAtomic(jobFilePath(jobId), updated);
    return updated;
  });
}

export async function markSceneContentGenerationJobRunning(
  jobId: string,
): Promise<SceneContentGenerationJob> {
  return updateSceneContentGenerationJob(jobId, {
    status: 'running',
    progress: 10,
    message: 'Scene content generation started',
    startedAt: new Date().toISOString(),
  });
}

export async function markSceneContentGenerationJobSucceeded(
  jobId: string,
  result: SceneContentGenerationJob['result'],
): Promise<SceneContentGenerationJob> {
  return updateSceneContentGenerationJob(jobId, {
    status: 'succeeded',
    progress: 100,
    message: 'Scene content generated successfully',
    completedAt: new Date().toISOString(),
    result,
  });
}

export async function markSceneContentGenerationJobFailed(
  jobId: string,
  error: string,
): Promise<SceneContentGenerationJob> {
  return updateSceneContentGenerationJob(jobId, {
    status: 'failed',
    progress: 100,
    message: 'Scene content generation failed',
    completedAt: new Date().toISOString(),
    error,
  });
}
