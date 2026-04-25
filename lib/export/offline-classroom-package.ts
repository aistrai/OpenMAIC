import type JSZip from 'jszip';

import { isMediaPlaceholder, useMediaGenerationStore } from '@/lib/store/media-generation';
import type { SpeechAction } from '@/lib/types/action';
import type { Scene, Stage } from '@/lib/types/stage';
import { db, mediaFileKey } from '@/lib/utils/database';
import { createLogger } from '@/lib/logger';

const log = createLogger('OfflineClassroomPackage');

type ExportClassroom = {
  id: string;
  stage: Stage;
  scenes: Scene[];
  exportedAt: string;
};

export function safeExportFileName(value: string, fallback = 'classroom'): string {
  const trimmed = value.trim().replace(/[\\/:*?"<>|]/g, '_');
  return trimmed || fallback;
}

function getExtensionFromUrl(url: string): string | undefined {
  const match = url.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
  return match?.[1]?.toLowerCase();
}

function getExtensionFromMime(mimeType: string, fallback: string): string {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('gif')) return 'gif';
  if (mimeType.includes('mp3') || mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('webm')) return 'webm';
  return fallback;
}

async function fetchBlobResource(url: string): Promise<Blob | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return response.blob();
  } catch (error) {
    log.warn('Failed to fetch export resource:', url, error);
    return null;
  }
}

async function resolveAudioBlob(action: SpeechAction): Promise<{ blob: Blob; ext: string } | null> {
  if (action.audioUrl) {
    const blob = await fetchBlobResource(action.audioUrl);
    if (blob) {
      return {
        blob,
        ext: getExtensionFromUrl(action.audioUrl) || getExtensionFromMime(blob.type, 'mp3'),
      };
    }
  }

  if (action.audioId) {
    const record = await db.audioFiles.get(action.audioId).catch(() => null);
    if (record?.blob) {
      return {
        blob: record.blob,
        ext: record.format || getExtensionFromMime(record.blob.type, 'mp3'),
      };
    }
  }

  return null;
}

async function resolveMediaBlob(
  stageId: string,
  src: string,
): Promise<{ blob: Blob; poster?: Blob; ext: string; posterExt?: string } | null> {
  if (isMediaPlaceholder(src)) {
    const task = useMediaGenerationStore.getState().tasks[src];
    if (task?.status === 'done' && task.objectUrl) {
      const blob = await fetchBlobResource(task.objectUrl);
      const poster = task.poster ? await fetchBlobResource(task.poster) : undefined;
      if (blob) {
        return {
          blob,
          poster: poster || undefined,
          ext: getExtensionFromMime(blob.type, task.type === 'image' ? 'png' : 'mp4'),
          posterExt: poster ? getExtensionFromMime(poster.type, 'jpg') : undefined,
        };
      }
    }

    const record = await db.mediaFiles.get(mediaFileKey(stageId, src)).catch(() => null);
    if (record?.blob && !record.error) {
      return {
        blob: record.blob,
        poster: record.poster,
        ext: getExtensionFromMime(
          record.mimeType || record.blob.type,
          record.type === 'image' ? 'png' : 'mp4',
        ),
        posterExt: record.poster ? getExtensionFromMime(record.poster.type, 'jpg') : undefined,
      };
    }
    return null;
  }

  const blob = await fetchBlobResource(src);
  if (!blob) return null;

  return {
    blob,
    ext: getExtensionFromUrl(src) || getExtensionFromMime(blob.type, 'bin'),
  };
}

export async function buildOfflineClassroomPackage(
  zip: JSZip,
  stage: Stage,
  scenes: Scene[],
): Promise<void> {
  const exportData: ExportClassroom = structuredClone({
    id: stage.id,
    stage,
    scenes,
    exportedAt: new Date().toISOString(),
  });

  const audioFolder = zip.folder('assets/audio');
  const mediaFolder = zip.folder('assets/media');
  const interactiveFolder = zip.folder('assets/interactive');

  for (const scene of exportData.scenes) {
    if (scene.actions) {
      for (let index = 0; index < scene.actions.length; index++) {
        const action = scene.actions[index];
        if (action.type !== 'speech') continue;

        const speechAction = action as SpeechAction;
        const audioId = speechAction.audioId || `speech_${scene.id}_${index}`;
        const audio = await resolveAudioBlob(speechAction);
        if (!audio) continue;

        const audioName = `${safeExportFileName(audioId, 'audio')}.${audio.ext}`;
        audioFolder?.file(audioName, audio.blob);
        speechAction.audioUrl = `assets/audio/${audioName}`;
        speechAction.audioId = audioId;
      }
    }

    if (scene.content.type === 'interactive' && scene.content.html) {
      const htmlName = `${String(scene.order + 1).padStart(2, '0')}_${safeExportFileName(
        scene.title,
        scene.id,
      )}.html`;
      interactiveFolder?.file(htmlName, scene.content.html);
      scene.content.url = `assets/interactive/${htmlName}`;
    }

    if (scene.content.type !== 'slide') continue;

    const elements = scene.content.canvas.elements || [];
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index];
      if (element.type !== 'image' && element.type !== 'video') continue;

      const media = await resolveMediaBlob(scene.stageId, element.src);
      if (!media) continue;

      const prefix = `${String(scene.order + 1).padStart(2, '0')}_${safeExportFileName(
        element.id || `media_${index}`,
      )}`;
      const mediaName = `${prefix}.${media.ext}`;
      mediaFolder?.file(mediaName, media.blob);
      element.src = `assets/media/${mediaName}`;

      if (element.type === 'video' && media.poster) {
        const posterName = `${prefix}_poster.${media.posterExt || 'jpg'}`;
        mediaFolder?.file(posterName, media.poster);
        element.poster = `assets/media/${posterName}`;
      }
    }
  }

  zip.file('assets/classroom.json', JSON.stringify(exportData, null, 2));
  zip.file('index.html', buildOfflinePlayerHtml(exportData));
}

function buildOfflinePlayerHtml(classroom: ExportClassroom): string {
  const classroomJson = JSON.stringify(classroom).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Offline Classroom</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Microsoft YaHei", "Segoe UI", sans-serif; background: #f5f3ee; color: #1f2933; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: minmax(220px, 280px) 1fr; }
    aside { border-right: 1px solid #e2ddd2; background: #fffaf0; padding: 18px; overflow: auto; }
    main { display: grid; grid-template-rows: 1fr auto; min-width: 0; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    .desc { font-size: 12px; color: #667085; margin-bottom: 18px; line-height: 1.5; }
    .scene-btn { width: 100%; border: 0; background: transparent; text-align: left; padding: 10px 12px; border-radius: 8px; cursor: pointer; color: #425466; }
    .scene-btn.active { background: #1f2933; color: #fff; }
    .scene-btn span { display: block; font-size: 12px; opacity: .7; }
    .stage-wrap { display: grid; place-items: center; padding: 24px; min-width: 0; overflow: auto; }
    .slide { position: relative; width: min(100%, 1100px); aspect-ratio: 16 / 9; background: #fff; overflow: hidden; box-shadow: 0 16px 50px rgba(31,41,51,.16); transform-origin: center; }
    .el { position: absolute; overflow: hidden; }
    .text { line-height: 1.35; word-break: break-word; }
    .text * { max-width: 100%; }
    img, video { width: 100%; height: 100%; object-fit: cover; display: block; }
    iframe { width: min(100%, 1100px); height: min(70vh, 760px); border: 0; background: #fff; box-shadow: 0 16px 50px rgba(31,41,51,.16); }
    .fallback { width: min(100%, 900px); background: #fff; padding: 28px; border-radius: 8px; line-height: 1.6; box-shadow: 0 16px 50px rgba(31,41,51,.12); }
    .controls { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-top: 1px solid #e2ddd2; background: rgba(255,250,240,.92); }
    button.control { border: 0; border-radius: 8px; padding: 9px 14px; background: #1f2933; color: #fff; cursor: pointer; }
    button.control.secondary { background: #e7e0d1; color: #1f2933; }
    .caption { flex: 1; min-width: 0; font-size: 14px; color: #425466; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    @media (max-width: 760px) {
      .shell { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
      aside { max-height: 180px; border-right: 0; border-bottom: 1px solid #e2ddd2; }
      .stage-wrap { padding: 12px; }
      .controls { flex-wrap: wrap; }
      .caption { flex-basis: 100%; white-space: normal; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <h1 id="title"></h1>
      <div class="desc" id="desc"></div>
      <div id="sceneList"></div>
    </aside>
    <main>
      <div class="stage-wrap" id="stage"></div>
      <div class="controls">
        <button class="control secondary" id="prevBtn">Prev</button>
        <button class="control" id="playBtn">Play</button>
        <button class="control secondary" id="nextBtn">Next</button>
        <div class="caption" id="caption"></div>
      </div>
    </main>
  </div>
  <script id="classroom-data" type="application/json">${classroomJson}</script>
  <script>
    const classroom = JSON.parse(document.getElementById('classroom-data').textContent);
    const scenes = [...(classroom.scenes || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
    let sceneIndex = 0;
    let actionIndex = 0;
    let playing = false;
    let audio = null;
    const title = document.getElementById('title');
    const desc = document.getElementById('desc');
    const sceneList = document.getElementById('sceneList');
    const stage = document.getElementById('stage');
    const caption = document.getElementById('caption');
    const playBtn = document.getElementById('playBtn');
    title.textContent = classroom.stage?.name || 'Offline Classroom';
    desc.textContent = classroom.stage?.description || '';
    function px(value) { return typeof value === 'number' ? value + 'px' : value || '0px'; }
    function renderSceneList() {
      sceneList.innerHTML = '';
      scenes.forEach((scene, index) => {
        const btn = document.createElement('button');
        btn.className = 'scene-btn' + (index === sceneIndex ? ' active' : '');
        btn.innerHTML = '<span>' + String(index + 1).padStart(2, '0') + '</span>' + (scene.title || 'Scene');
        btn.onclick = () => { stopAudio(); sceneIndex = index; actionIndex = 0; render(); };
        sceneList.appendChild(btn);
      });
    }
    function renderSlide(scene) {
      const canvas = scene.content?.canvas;
      const slide = document.createElement('div');
      slide.className = 'slide';
      const bg = canvas?.background;
      if (bg?.type === 'solid') slide.style.background = bg.color;
      if (bg?.type === 'image' && bg.image?.src) {
        slide.style.backgroundImage = 'url("' + bg.image.src + '")';
        slide.style.backgroundSize = 'cover';
        slide.style.backgroundPosition = 'center';
      }
      for (const element of canvas?.elements || []) {
        const el = document.createElement('div');
        el.className = 'el';
        el.style.left = px(element.left);
        el.style.top = px(element.top);
        el.style.width = px(element.width);
        el.style.height = px(element.height);
        el.style.transform = 'rotate(' + (element.rotate || 0) + 'deg)';
        if (element.type === 'text') {
          el.classList.add('text');
          el.innerHTML = element.content || '';
          el.style.color = element.defaultColor || '#111';
          el.style.fontFamily = element.defaultFontName || 'inherit';
          if (element.fill) el.style.background = element.fill;
        } else if (element.type === 'image') {
          const img = document.createElement('img');
          img.src = element.src;
          el.appendChild(img);
        } else if (element.type === 'video') {
          const video = document.createElement('video');
          video.src = element.src;
          video.controls = true;
          if (element.poster) video.poster = element.poster;
          el.appendChild(video);
        } else if (element.type === 'shape') {
          el.style.background = element.fill || 'transparent';
          if (element.outline?.color) el.style.border = (element.outline.width || 1) + 'px solid ' + element.outline.color;
        } else {
          continue;
        }
        slide.appendChild(el);
      }
      return slide;
    }
    function render() {
      const scene = scenes[sceneIndex];
      renderSceneList();
      caption.textContent = '';
      stage.innerHTML = '';
      if (!scene) return;
      if (scene.content?.type === 'slide') stage.appendChild(renderSlide(scene));
      else if (scene.content?.type === 'interactive' && scene.content.url) {
        const iframe = document.createElement('iframe');
        iframe.src = scene.content.url;
        stage.appendChild(iframe);
      } else {
        const box = document.createElement('div');
        box.className = 'fallback';
        box.textContent = scene.title || 'Unsupported scene';
        stage.appendChild(box);
      }
    }
    function stopAudio() {
      if (audio) { audio.pause(); audio = null; }
      playing = false;
      playBtn.textContent = 'Play';
    }
    async function playNextAction() {
      const scene = scenes[sceneIndex];
      const actions = scene?.actions || [];
      if (actionIndex >= actions.length) {
        if (sceneIndex < scenes.length - 1) {
          sceneIndex++;
          actionIndex = 0;
          render();
          if (playing) return playNextAction();
        }
        stopAudio();
        return;
      }
      const action = actions[actionIndex++];
      if (action.type !== 'speech') return playNextAction();
      caption.textContent = action.text || '';
      if (!action.audioUrl) return setTimeout(playNextAction, Math.max(1200, (action.text || '').length * 90));
      audio = new Audio(action.audioUrl);
      audio.onended = playNextAction;
      audio.onerror = playNextAction;
      try { await audio.play(); } catch { playNextAction(); }
    }
    playBtn.onclick = () => {
      if (playing) { stopAudio(); return; }
      playing = true;
      playBtn.textContent = 'Pause';
      playNextAction();
    };
    document.getElementById('prevBtn').onclick = () => {
      stopAudio();
      sceneIndex = Math.max(0, sceneIndex - 1);
      actionIndex = 0;
      render();
    };
    document.getElementById('nextBtn').onclick = () => {
      stopAudio();
      sceneIndex = Math.min(scenes.length - 1, sceneIndex + 1);
      actionIndex = 0;
      render();
    };
    render();
  </script>
</body>
</html>`;
}
