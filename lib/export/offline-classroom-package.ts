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
    html, body { width: 100%; height: 100%; overflow: hidden; }
    body { margin: 0; font-family: "Microsoft YaHei", "Segoe UI", sans-serif; background: #f7f7fb; color: #111827; }
    button { font: inherit; }
    .shell { height: 100dvh; display: grid; grid-template-columns: 236px minmax(0, 1fr); overflow: hidden; background: radial-gradient(circle at 20% 0%, #ffffff 0, #f7f7fb 34%, #eef1f8 100%); }
    .sidebar { min-height: 0; border-right: 1px solid rgba(15,23,42,.08); background: rgba(255,255,255,.84); backdrop-filter: blur(18px); display: flex; flex-direction: column; overflow: hidden; box-shadow: 2px 0 24px rgba(15,23,42,.04); }
    .brand { height: 56px; padding: 12px 14px 8px; display: flex; flex-direction: column; justify-content: center; gap: 3px; flex: 0 0 auto; }
    .brand h1 { font-size: 14px; line-height: 1.25; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .brand p { margin: 0; font-size: 11px; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .scene-list { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 8px 10px 14px; display: flex; flex-direction: column; gap: 8px; }
    .scene-btn { width: 100%; border: 0; background: transparent; text-align: left; padding: 8px; border-radius: 12px; cursor: pointer; color: #475569; display: grid; grid-template-columns: 24px minmax(0,1fr); gap: 8px; align-items: center; transition: background .18s ease, box-shadow .18s ease, color .18s ease; }
    .scene-btn:hover { background: rgba(241,245,249,.9); }
    .scene-btn.active { background: #f3e8ff; color: #6d28d9; box-shadow: inset 0 0 0 1px rgba(147,51,234,.24); }
    .scene-no { width: 22px; height: 22px; border-radius: 999px; display: grid; place-items: center; font-size: 11px; font-weight: 800; background: #eef2ff; color: #64748b; }
    .scene-btn.active .scene-no { background: #7c3aed; color: white; }
    .scene-title { min-width: 0; font-size: 12px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .scene-type { font-size: 10px; color: #94a3b8; margin-top: 2px; text-transform: uppercase; letter-spacing: .04em; }
    .main { min-width: 0; min-height: 0; display: grid; grid-template-rows: 56px minmax(0,1fr) 174px; overflow: hidden; }
    .topbar { min-width: 0; height: 56px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 18px; border-bottom: 1px solid rgba(15,23,42,.06); background: rgba(255,255,255,.66); backdrop-filter: blur(14px); }
    .top-title { min-width: 0; }
    .top-title .kicker { font-size: 11px; color: #94a3b8; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .top-title .name { font-size: 15px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pill { flex: 0 0 auto; font-size: 12px; color: #475569; border: 1px solid rgba(15,23,42,.08); background: white; border-radius: 999px; padding: 7px 10px; box-shadow: 0 8px 20px rgba(15,23,42,.04); }
    .stage-wrap { min-height: 0; min-width: 0; padding: 18px; display: grid; place-items: center; overflow: hidden; position: relative; }
    .slide-frame { width: 100%; height: 100%; min-height: 0; position: relative; display: grid; place-items: center; overflow: hidden; }
    .slide { position: absolute; left: 50%; top: 50%; background: #fff; overflow: hidden; box-shadow: 0 18px 60px rgba(15,23,42,.18); transform-origin: center center; transition: transform .18s ease; }
    .slide.has-focus .el:not(.focus-target) { filter: brightness(.55) saturate(.8); opacity: .42; }
    .el { position: absolute; overflow: hidden; transition: opacity .18s ease, filter .18s ease, box-shadow .18s ease; }
    .el.focus-target { z-index: 20; box-shadow: 0 0 0 4px rgba(250,204,21,.95), 0 0 0 9999px rgba(15,23,42,.38); border-radius: 8px; }
    .el.laser-target::after { content: ""; position: absolute; left: 50%; top: 50%; width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 999px; background: #ef4444; box-shadow: 0 0 0 8px rgba(239,68,68,.18), 0 0 28px rgba(239,68,68,.8); animation: pulse 1s infinite; }
    .text { line-height: 1.35; word-break: break-word; }
    .text * { max-width: 100%; }
    img, video { width: 100%; height: 100%; object-fit: cover; display: block; }
    iframe { width: min(100%, 1100px); height: 100%; min-height: 420px; border: 0; border-radius: 16px; background: #fff; box-shadow: 0 18px 60px rgba(15,23,42,.18); }
    .fallback { width: min(100%, 900px); background: white; padding: 28px; border-radius: 16px; line-height: 1.6; box-shadow: 0 18px 60px rgba(15,23,42,.12); }
    .quiz { width: min(100%, 980px); height: 100%; overflow: auto; border-radius: 18px; background: white; box-shadow: 0 18px 60px rgba(15,23,42,.14); padding: 22px; }
    .quiz-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
    .quiz h2 { margin: 0; font-size: 22px; color: #111827; }
    .quiz-sub { margin-top: 4px; color: #64748b; font-size: 13px; }
    .quiz-score { flex: 0 0 auto; border-radius: 999px; background: #f3e8ff; color: #6d28d9; font-size: 12px; font-weight: 800; padding: 7px 10px; }
    .q-card { border: 1px solid rgba(15,23,42,.08); background: #f8fafc; border-radius: 16px; padding: 16px; margin-bottom: 12px; }
    .q-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; color: #64748b; font-size: 12px; font-weight: 800; }
    .q-type { border-radius: 999px; background: white; border: 1px solid rgba(15,23,42,.08); padding: 3px 8px; }
    .q-title { font-size: 15px; line-height: 1.6; font-weight: 700; color: #1e293b; margin-bottom: 12px; white-space: pre-wrap; }
    .option { width: 100%; border: 1px solid rgba(15,23,42,.08); background: white; color: #334155; border-radius: 12px; padding: 10px 12px; margin-top: 8px; text-align: left; cursor: pointer; display: grid; grid-template-columns: 28px minmax(0,1fr); gap: 8px; align-items: start; transition: border .15s ease, background .15s ease, transform .15s ease; }
    .option:hover { border-color: rgba(124,58,237,.35); background: #faf5ff; }
    .option.selected { border-color: rgba(124,58,237,.55); background: #f3e8ff; color: #5b21b6; }
    .option.correct { border-color: rgba(34,197,94,.55); background: #ecfdf5; color: #166534; }
    .option.incorrect { border-color: rgba(239,68,68,.45); background: #fef2f2; color: #991b1b; }
    .opt-key { font-weight: 900; color: inherit; }
    .short-answer { width: 100%; min-height: 86px; resize: vertical; border-radius: 12px; border: 1px solid rgba(15,23,42,.1); background: white; padding: 11px 12px; font: inherit; color: #334155; outline: none; }
    .short-answer:focus { border-color: rgba(124,58,237,.55); box-shadow: 0 0 0 3px rgba(124,58,237,.12); }
    .analysis { margin-top: 12px; border-radius: 12px; background: #fff7ed; color: #9a3412; padding: 10px 12px; font-size: 13px; line-height: 1.55; white-space: pre-wrap; }
    .quiz-actions { position: sticky; bottom: -22px; display: flex; justify-content: flex-end; padding-top: 12px; background: linear-gradient(to top, white 70%, rgba(255,255,255,0)); }
    .quiz-btn { border: 0; border-radius: 999px; background: #111827; color: white; padding: 10px 16px; font-weight: 800; cursor: pointer; box-shadow: 0 10px 26px rgba(15,23,42,.16); }
    .quiz-btn.secondary { background: #e2e8f0; color: #334155; box-shadow: none; }
    .roundtable { min-height: 0; border-top: 1px solid rgba(15,23,42,.08); background: rgba(255,255,255,.82); backdrop-filter: blur(18px); display: grid; grid-template-columns: 132px minmax(0,1fr) auto; gap: 14px; padding: 14px 18px; overflow: hidden; }
    .teacher { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .avatar { width: 48px; height: 48px; border-radius: 18px; display: grid; place-items: center; color: white; font-weight: 900; background: linear-gradient(135deg, #7c3aed, #2563eb); box-shadow: 0 10px 30px rgba(79,70,229,.25); }
    .teacher-name { font-size: 12px; font-weight: 800; color: #334155; }
    .teacher-state { font-size: 11px; color: #64748b; margin-top: 2px; }
    .speech-card { min-width: 0; min-height: 0; border-radius: 16px; background: #f8fafc; border: 1px solid rgba(15,23,42,.06); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; overflow: hidden; }
    .caption { flex: 1 1 auto; min-height: 0; overflow: auto; color: #334155; font-size: 14px; line-height: 1.55; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
    .caption.empty { color: #94a3b8; }
    .progress-track { height: 4px; border-radius: 999px; background: #e2e8f0; overflow: hidden; flex: 0 0 auto; }
    .progress-bar { width: 0%; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #7c3aed, #06b6d4); transition: width .12s linear; }
    .controls { align-self: center; min-width: 0; height: 34px; display: flex; align-items: center; gap: 3px; padding: 4px 5px; border-radius: 12px; background: rgba(255,255,255,.86); border: 1px solid rgba(15,23,42,.08); box-shadow: 0 10px 28px rgba(15,23,42,.08); }
    .control { width: 28px; height: 26px; border: 0; border-radius: 8px; cursor: pointer; color: #64748b; background: transparent; display: grid; place-items: center; transition: transform .14s ease, background .14s ease, color .14s ease; }
    .control:hover { background: rgba(100,116,139,.1); color: #334155; }
    .control:active { transform: scale(.9); }
    .control.playing { color: #7c3aed; background: rgba(124,58,237,.1); }
    .control svg { width: 15px; height: 15px; stroke-width: 2.4; }
    .ctrl-divider { width: 1px; height: 14px; background: rgba(203,213,225,.9); margin: 0 2px; }
    .speed { width: 38px; height: 24px; border: 0; border-radius: 7px; cursor: pointer; background: transparent; color: #64748b; font-size: 11px; font-weight: 800; line-height: 1; }
    .speed:hover, .speed.active { color: #7c3aed; background: rgba(124,58,237,.1); }
    @keyframes pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.4); opacity: .58; } }
    @media (max-width: 820px) {
      .shell { grid-template-columns: 1fr; grid-template-rows: 112px minmax(0,1fr); }
      .sidebar { height: 112px; border-right: 0; border-bottom: 1px solid rgba(15,23,42,.08); }
      .brand { height: 42px; padding-bottom: 2px; }
      .scene-list { flex-direction: row; overflow-x: auto; overflow-y: hidden; padding: 6px 10px 10px; }
      .scene-btn { width: 180px; flex: 0 0 180px; }
      .main { grid-template-rows: 48px minmax(0,1fr) 190px; }
      .roundtable { grid-template-columns: 1fr; grid-template-rows: auto minmax(0,1fr) auto; gap: 8px; padding: 10px; }
      .teacher { display: none; }
      .controls { justify-content: center; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <h1 id="title"></h1>
        <p id="desc"></p>
      </div>
      <div class="scene-list" id="sceneList"></div>
    </aside>
    <main class="main">
      <div class="topbar">
        <div class="top-title">
          <div class="kicker">Offline classroom</div>
          <div class="name" id="sceneTitle"></div>
        </div>
        <div class="pill" id="positionPill"></div>
      </div>
      <div class="stage-wrap" id="stage"></div>
      <div class="roundtable">
        <div class="teacher">
          <div class="avatar">AI</div>
          <div>
            <div class="teacher-name">Teacher</div>
            <div class="teacher-state" id="teacherState">Ready</div>
          </div>
        </div>
        <div class="speech-card">
          <div class="caption empty" id="caption">Press Play to start the lecture.</div>
          <div class="progress-track"><div class="progress-bar" id="progressBar"></div></div>
        </div>
        <div class="controls">
          <button class="speed" id="speedBtn" title="Playback speed">1x</button>
          <span class="ctrl-divider"></span>
          <button class="control" id="prevBtn" title="Previous" aria-label="Previous">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M15 18l-6-6 6-6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button class="control" id="playBtn" title="Play" aria-label="Play">
            <span id="playIcon"></span>
          </button>
          <button class="control" id="nextBtn" title="Next" aria-label="Next">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M9 18l6-6-6-6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
    </main>
  </div>
  <script id="classroom-data" type="application/json">${classroomJson}</script>
  <script>
    const classroom = JSON.parse(document.getElementById('classroom-data').textContent);
    const scenes = [...(classroom.scenes || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
    let sceneIndex = 0;
    let actionIndex = 0;
    let status = 'idle';
    let audio = null;
    let loopToken = 0;
    let playbackRate = 1;
    let activeFocusElementId = null;
    let activeFocusType = null;
    const quizAnswers = {};
    const revealedQuizScenes = new Set();
    const title = document.getElementById('title');
    const desc = document.getElementById('desc');
    const sceneList = document.getElementById('sceneList');
    const stage = document.getElementById('stage');
    const caption = document.getElementById('caption');
    const playBtn = document.getElementById('playBtn');
    const playIcon = document.getElementById('playIcon');
    const sceneTitle = document.getElementById('sceneTitle');
    const positionPill = document.getElementById('positionPill');
    const teacherState = document.getElementById('teacherState');
    const progressBar = document.getElementById('progressBar');
    const speedBtn = document.getElementById('speedBtn');
    title.textContent = classroom.stage?.name || 'Offline Classroom';
    desc.textContent = classroom.stage?.description || '';
    function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
    function px(value) { return typeof value === 'number' ? value + 'px' : value || '0px'; }
    function sceneTypeLabel(scene) { return scene?.content?.type || scene?.type || 'scene'; }
    function icon(name) {
      if (name === 'pause') return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.75A1.75 1.75 0 0 1 9.75 4h.5A1.75 1.75 0 0 1 12 5.75v12.5A1.75 1.75 0 0 1 10.25 20h-.5A1.75 1.75 0 0 1 8 18.25V5.75Zm4 0A1.75 1.75 0 0 1 13.75 4h.5A1.75 1.75 0 0 1 16 5.75v12.5A1.75 1.75 0 0 1 14.25 20h-.5A1.75 1.75 0 0 1 12 18.25V5.75Z"/></svg>';
      if (name === 'replay') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 4v6h6" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.2 14.5A7.5 7.5 0 1 0 6.1 8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.6v12.8c0 .9 1 1.45 1.76.96l9.6-6.4a1.15 1.15 0 0 0 0-1.92l-9.6-6.4A1.15 1.15 0 0 0 8 5.6Z"/></svg>';
    }
    function updateControls() {
      const isPlaying = status === 'playing';
      playIcon.innerHTML = isPlaying ? icon('pause') : status === 'completed' ? icon('replay') : icon('play');
      playBtn.classList.toggle('playing', isPlaying);
      playBtn.title = isPlaying ? 'Pause' : status === 'completed' ? 'Replay' : 'Play';
      playBtn.setAttribute('aria-label', playBtn.title);
      teacherState.textContent = status === 'playing' ? 'Speaking' : status === 'paused' ? 'Paused' : status === 'completed' ? 'Completed' : 'Ready';
      speedBtn.textContent = playbackRate + 'x';
      speedBtn.classList.toggle('active', playbackRate !== 1);
    }
    function renderSceneList() {
      sceneList.innerHTML = '';
      scenes.forEach((scene, index) => {
        const btn = document.createElement('button');
        btn.className = 'scene-btn' + (index === sceneIndex ? ' active' : '');
        btn.innerHTML = '<span class="scene-no">' + (index + 1) + '</span><span><span class="scene-title">' + (scene.title || 'Scene') + '</span><span class="scene-type">' + sceneTypeLabel(scene) + '</span></span>';
        btn.onclick = () => { stopPlayback(); sceneIndex = index; actionIndex = 0; activeFocusElementId = null; render(); };
        sceneList.appendChild(btn);
      });
      const active = sceneList.querySelector('.scene-btn.active');
      if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    function fitSlide() {
      const frame = stage.querySelector('.slide-frame');
      const slide = stage.querySelector('.slide');
      if (!frame || !slide) return;
      const designWidth = Number(slide.dataset.designWidth || 960);
      const designHeight = Number(slide.dataset.designHeight || 540);
      const scale = Math.min(frame.clientWidth / designWidth, frame.clientHeight / designHeight);
      slide.style.transform = 'translate(-50%, -50%) scale(' + Math.max(.1, scale) + ')';
    }
    window.addEventListener('resize', fitSlide);
    if ('ResizeObserver' in window) {
      new ResizeObserver(fitSlide).observe(stage);
    }
    function renderSlide(scene) {
      const canvas = scene.content?.canvas;
      const designWidth = canvas?.viewportSize || 960;
      const designHeight = Math.round(designWidth * (canvas?.viewportRatio || 0.5625));
      const frame = document.createElement('div');
      frame.className = 'slide-frame';
      const slide = document.createElement('div');
      slide.className = 'slide';
      slide.dataset.designWidth = String(designWidth);
      slide.dataset.designHeight = String(designHeight);
      slide.style.width = designWidth + 'px';
      slide.style.height = designHeight + 'px';
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
        el.dataset.elementId = element.id || '';
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
      frame.appendChild(slide);
      return frame;
    }
    function toArray(value) {
      if (!value) return [];
      return Array.isArray(value) ? value : [value];
    }
    function arraysEqual(a, b) {
      if (a.length !== b.length) return false;
      const left = [...a].sort();
      const right = [...b].sort();
      return left.every((value, index) => value === right[index]);
    }
    function quizAnswerKey(scene, question) {
      return scene.id + '::' + question.id;
    }
    function getQuizAnswer(scene, question) {
      const answer = quizAnswers[quizAnswerKey(scene, question)];
      return question.type === 'multiple' ? toArray(answer) : answer || '';
    }
    function isShortAnswer(question) {
      return question.type === 'short_answer' || (!question.hasAnswer && toArray(question.answer).length === 0);
    }
    function questionTypeLabel(question) {
      if (question.type === 'multiple') return 'Multiple';
      if (isShortAnswer(question)) return 'Short answer';
      return 'Single';
    }
    function renderQuiz(scene) {
      const questions = scene.content?.questions || [];
      const revealed = revealedQuizScenes.has(scene.id);
      const root = document.createElement('div');
      root.className = 'quiz';

      let total = 0;
      let earned = 0;
      for (const question of questions) {
        const points = question.points || 1;
        total += points;
        if (!isShortAnswer(question)) {
          const answer = toArray(getQuizAnswer(scene, question));
          if (arraysEqual(answer, toArray(question.answer))) earned += points;
        }
      }

      const head = document.createElement('div');
      head.className = 'quiz-head';
      const intro = document.createElement('div');
      const h2 = document.createElement('h2');
      h2.textContent = scene.title || 'Quiz';
      const sub = document.createElement('div');
      sub.className = 'quiz-sub';
      sub.textContent = questions.length + ' question' + (questions.length === 1 ? '' : 's');
      intro.appendChild(h2);
      intro.appendChild(sub);
      const score = document.createElement('div');
      score.className = 'quiz-score';
      score.textContent = revealed ? 'Score ' + earned + ' / ' + total : 'Quiz';
      head.appendChild(intro);
      head.appendChild(score);
      root.appendChild(head);

      questions.forEach((question, index) => {
        const card = document.createElement('div');
        card.className = 'q-card';
        const meta = document.createElement('div');
        meta.className = 'q-meta';
        meta.innerHTML = '<span>Q' + (index + 1) + '</span><span class="q-type">' + questionTypeLabel(question) + '</span>';
        const title = document.createElement('div');
        title.className = 'q-title';
        title.textContent = question.question || '';
        card.appendChild(meta);
        card.appendChild(title);

        if (isShortAnswer(question)) {
          const textarea = document.createElement('textarea');
          textarea.className = 'short-answer';
          textarea.placeholder = 'Write your answer here...';
          textarea.value = getQuizAnswer(scene, question);
          textarea.oninput = () => {
            quizAnswers[quizAnswerKey(scene, question)] = textarea.value;
          };
          card.appendChild(textarea);
        } else {
          const selected = toArray(getQuizAnswer(scene, question));
          for (const option of question.options || []) {
            const btn = document.createElement('button');
            const isSelected = selected.includes(option.value);
            const isCorrectOption = toArray(question.answer).includes(option.value);
            btn.className = 'option' +
              (isSelected ? ' selected' : '') +
              (revealed && isCorrectOption ? ' correct' : '') +
              (revealed && isSelected && !isCorrectOption ? ' incorrect' : '');
            btn.innerHTML = '<span class="opt-key"></span><span></span>';
            btn.children[0].textContent = option.value;
            btn.children[1].textContent = option.label;
            btn.onclick = () => {
              const key = quizAnswerKey(scene, question);
              if (question.type === 'multiple') {
                const current = new Set(toArray(quizAnswers[key]));
                if (current.has(option.value)) current.delete(option.value);
                else current.add(option.value);
                quizAnswers[key] = [...current];
              } else {
                quizAnswers[key] = option.value;
              }
              render();
            };
            card.appendChild(btn);
          }
        }

        if (revealed) {
          const analysis = document.createElement('div');
          analysis.className = 'analysis';
          const answerText = toArray(question.answer).join(', ');
          analysis.textContent =
            (answerText ? 'Answer: ' + answerText + '\\n' : '') +
            (question.analysis || 'No analysis provided.');
          card.appendChild(analysis);
        }

        root.appendChild(card);
      });

      const actions = document.createElement('div');
      actions.className = 'quiz-actions';
      const btn = document.createElement('button');
      btn.className = 'quiz-btn' + (revealed ? ' secondary' : '');
      btn.textContent = revealed ? 'Hide result' : 'Check answers';
      btn.onclick = () => {
        if (revealedQuizScenes.has(scene.id)) revealedQuizScenes.delete(scene.id);
        else revealedQuizScenes.add(scene.id);
        render();
      };
      actions.appendChild(btn);
      root.appendChild(actions);
      return root;
    }
    function render() {
      const scene = scenes[sceneIndex];
      renderSceneList();
      stage.innerHTML = '';
      if (!scene) return;
      sceneTitle.textContent = scene.title || 'Scene';
      positionPill.textContent = (sceneIndex + 1) + ' / ' + scenes.length;
      if (scene.content?.type === 'slide') stage.appendChild(renderSlide(scene));
      else if (scene.content?.type === 'quiz') stage.appendChild(renderQuiz(scene));
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
      requestAnimationFrame(() => { fitSlide(); applyFocus(activeFocusElementId, activeFocusType); });
    }
    function setCaption(text, empty) {
      caption.textContent = text || '';
      caption.classList.toggle('empty', !!empty);
    }
    function clearFocus() {
      const slide = stage.querySelector('.slide');
      if (slide) slide.classList.remove('has-focus');
      stage.querySelectorAll('.focus-target,.laser-target').forEach(el => el.classList.remove('focus-target', 'laser-target'));
      activeFocusElementId = null;
      activeFocusType = null;
    }
    function elementSelector(elementId) {
      const escaped = window.CSS && CSS.escape ? CSS.escape(elementId) : String(elementId).replace(/["\\\\]/g, '\\\\$&');
      return '[data-element-id="' + escaped + '"]';
    }
    function applyFocus(elementId, type) {
      stage.querySelectorAll('.focus-target,.laser-target').forEach(el => el.classList.remove('focus-target', 'laser-target'));
      const slide = stage.querySelector('.slide');
      if (!slide) return;
      if (!elementId) { slide.classList.remove('has-focus'); return; }
      const target = stage.querySelector(elementSelector(elementId));
      if (!target) { slide.classList.remove('has-focus'); return; }
      slide.classList.add('has-focus');
      target.classList.add('focus-target');
      if (type === 'laser') target.classList.add('laser-target');
      activeFocusElementId = elementId;
      activeFocusType = type;
    }
    function stopPlayback(markCompleted) {
      loopToken++;
      if (audio) { audio.pause(); audio = null; }
      status = markCompleted ? 'completed' : 'idle';
      progressBar.style.width = '0%';
      setCaption(markCompleted ? 'Lecture completed.' : 'Press Play to start the lecture.', true);
      updateControls();
    }
    async function playSpeech(action, token) {
      setCaption(action.text || '', false);
      if (!action.audioUrl) {
        await wait(Math.max(1200, (action.text || '').length * 90));
        return;
      }
      audio = new Audio(action.audioUrl);
      audio.playbackRate = playbackRate;
      progressBar.style.width = '0%';
      await new Promise(resolve => {
        audio.onended = resolve;
        audio.onerror = resolve;
        audio.ontimeupdate = () => {
          if (!audio || !audio.duration || token !== loopToken) return;
          progressBar.style.width = Math.min(100, (audio.currentTime / audio.duration) * 100) + '%';
        };
        audio.play().catch(resolve);
      });
      audio = null;
      progressBar.style.width = '0%';
    }
    async function executeAction(action, token) {
      if (action.type === 'spotlight') {
        applyFocus(action.elementId, 'spotlight');
        await wait(450);
        return;
      }
      if (action.type === 'laser') {
        applyFocus(action.elementId, 'laser');
        await wait(550);
        return;
      }
      if (action.type === 'play_video') {
        applyFocus(action.elementId, 'spotlight');
        const video = stage.querySelector(elementSelector(action.elementId) + ' video');
        if (!video) return;
        await new Promise(resolve => {
          video.onended = resolve;
          video.onerror = resolve;
          video.play().catch(resolve);
        });
        return;
      }
      if (action.type === 'speech') {
        await playSpeech(action, token);
      }
    }
    async function playLoop(token) {
      while (token === loopToken && status === 'playing') {
        const scene = scenes[sceneIndex];
        const actions = scene?.actions || [];
        if (actionIndex >= actions.length) {
          clearFocus();
          if (sceneIndex < scenes.length - 1) {
            sceneIndex++;
            actionIndex = 0;
            render();
            await wait(220);
            continue;
          }
          stopPlayback(true);
          return;
        }
        const action = actions[actionIndex++];
        await executeAction(action, token);
      }
    }
    function startOrResume() {
      if (status === 'playing') {
        status = 'paused';
        if (audio) audio.pause();
        updateControls();
        return;
      }
      if (status === 'completed') {
        sceneIndex = 0;
        actionIndex = 0;
        clearFocus();
        render();
      }
      status = 'playing';
      updateControls();
      if (audio && audio.paused) {
        audio.playbackRate = playbackRate;
        audio.play().catch(() => {});
        return;
      }
      const token = ++loopToken;
      playLoop(token);
    }
    playBtn.onclick = startOrResume;
    document.getElementById('prevBtn').onclick = () => {
      stopPlayback();
      sceneIndex = Math.max(0, sceneIndex - 1);
      actionIndex = 0;
      clearFocus();
      render();
    };
    document.getElementById('nextBtn').onclick = () => {
      stopPlayback();
      sceneIndex = Math.min(scenes.length - 1, sceneIndex + 1);
      actionIndex = 0;
      clearFocus();
      render();
    };
    speedBtn.onclick = () => {
      const speeds = [1, 1.25, 1.5, 2];
      playbackRate = speeds[(speeds.indexOf(playbackRate) + 1) % speeds.length];
      if (audio) audio.playbackRate = playbackRate;
      updateControls();
    };
    render();
    updateControls();
  </script>
</body>
</html>`;
}
