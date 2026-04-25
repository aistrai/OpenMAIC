import { type NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import {
  buildRequestOrigin,
  CLASSROOMS_DIR,
  isValidClassroomId,
} from '@/lib/server/classroom-storage';
import { apiError, apiSuccess } from '@/lib/server/api-response';

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

function extensionForMime(mimeType: string, fallback: string): string {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('gif')) return 'gif';
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('webm')) return 'webm';
  return fallback;
}

async function writeUploadFile(params: {
  classroomId: string;
  filename: string;
  file: File;
}): Promise<string> {
  if (params.file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`File too large: ${params.file.size} bytes`);
  }

  const mediaDir = path.join(CLASSROOMS_DIR, params.classroomId, 'media');
  await fs.mkdir(mediaDir, { recursive: true });

  const filePath = path.join(mediaDir, params.filename);
  const resolvedBase = path.resolve(CLASSROOMS_DIR, params.classroomId);
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(resolvedBase + path.sep)) {
    throw new Error('Invalid media path');
  }

  const buffer = Buffer.from(await params.file.arrayBuffer());
  await fs.writeFile(filePath, buffer);
  return filePath;
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const classroomId = String(formData.get('classroomId') || '');
    const elementId = String(formData.get('elementId') || '');
    const type = String(formData.get('type') || '');
    const file = formData.get('file');
    const poster = formData.get('poster');

    if (!classroomId || !elementId || !type || !(file instanceof File)) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'Missing classroomId, elementId, type, or file',
      );
    }
    if (!isValidClassroomId(classroomId) || !isValidClassroomId(elementId)) {
      return apiError('INVALID_REQUEST', 400, 'Invalid classroomId or elementId');
    }
    if (type !== 'image' && type !== 'video') {
      return apiError('INVALID_REQUEST', 400, 'Invalid media type');
    }

    const ext = extensionForMime(file.type, type === 'image' ? 'png' : 'mp4');
    const filename = `${elementId}.${ext}`;
    await writeUploadFile({ classroomId, filename, file });

    let posterUrl: string | undefined;
    if (poster instanceof File && poster.size > 0) {
      const posterExt = extensionForMime(poster.type, 'jpg');
      const posterFilename = `${elementId}_poster.${posterExt}`;
      await writeUploadFile({ classroomId, filename: posterFilename, file: poster });
      posterUrl = `${buildRequestOrigin(request)}/api/classroom-media/${classroomId}/media/${posterFilename}`;
    }

    const url = `${buildRequestOrigin(request)}/api/classroom-media/${classroomId}/media/${filename}`;
    return apiSuccess({ url, ...(posterUrl ? { posterUrl } : {}) });
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to store classroom media',
      error instanceof Error ? error.message : String(error),
    );
  }
}
