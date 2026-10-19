// @ts-check
/**
 * The shared timeline and media plan for editing-project serializers. exports.mjs prepares the files the plan
 * asks for; serializers consume it without file I/O. A timeline one frame off is a gap in the editor, so the
 * plan can be checked on its own.
 *
 * The rules:
 *   · Frames: a clip starts at round(at × fps) and ends at round(end × fps). Two clips back to back compute the same
 *     number for the cut, so there is never a one-frame gap.
 *   · Tracks reversed: film.html's first track is on top; xmeml's V1 is at the bottom. Clips overlapping on one track
 *     are spread over several (an editor's track shows one clip a frame).
 *   · A web page (a motion graphic) is always rendered: a full-frame ProRes 4444 with alpha, its placement in the
 *     picture. Footage and stills come as they are, placed with Basic Motion (uniform scale and a move); what Basic
 *     Motion can't say (a rotation, a speed change, an unknown size) is rendered too: rather less to adjust than a
 *     picture in the wrong place.
 *   · Sound comes as clips (each its own, with its level, footage's sound linked to its picture) on footage, voice,
 *     sound-effect and music tracks, or as those four mixed stems. FCPXML clips instead retain their source rows.
 *   · A hidden track's clips and a muted track's sounds are not dropped: they come disabled, one click from back on.
 *   · Fades (film.html `overrides`' `fade`): a picture that fades is rendered, its fades in its alpha; a sound that
 *     fades comes as an encoded file of its own part, from its first frame, with Audio Levels keyframes for its ramps (counted
 *     from the file's start, which is the clip's, so editors that count keyframes from either agree).
 */
import { spawn } from 'node:child_process';
import { clipKind, pictureRect, soundRole } from '../../src/film-doc.mjs';

/**
 * @typedef {import('../../src/film-doc.mjs').FilmBox} FilmBox
 * @typedef {{ w?: number, h?: number, duration?: number, fps?: number, hasVideo?: boolean, hasAudio?: boolean,
 *   channels?: number, sampleRate?: number, alpha?: boolean }} SourceFacts
 * @typedef {{ id: string, kind: 'page' | 'video' | 'still', src: string, path: string, at: number, end: number,
 *   from: number, speed: number, box?: FilmBox, track: number, hidden: boolean, styled?: boolean, faded?: boolean,
 *   facts: SourceFacts | null }} NlePicture
 *   A picture clip: its film seconds [at, end), its source from `from` at `speed`; `facts` its file's (w × h as the
 *   browser shows it), null for a page
 * @typedef {'voice' | 'music' | 'sfx' | 'footage'} SoundRole
 *   A sound's stem (see soundStem)
 * @typedef {{ id: string, src: string, path: string, at: number, from: number, to: number, speed: number, volume: number,
 *   enabled: boolean, role: SoundRole, track?: number, sourceRow?: string, picture?: string, facts: SourceFacts | null, fade?: [number, number] }} NleSound
 *   A sound: the source seconds [from, to) at `speed`, placed at film second `at`; `picture`: the footage clip it is
 *   the sound of; `fade`: its fades in and out, film seconds (fitted to its length)
 * @typedef {{ stage: { w: number, h: number }, duration: number, pictures: NlePicture[], sounds: NleSound[] }} NleFilm
 * @typedef {{ title: string, fps: number, audio: 'clips' | 'stems', media: 'copy' | 'link', mediaDir: string,
 *   mediaPolicy: import('./nle-media.mjs').NleMediaPolicy, stems?: SoundRole[], audioTracks?: 'roles' | 'source' }} NlePlanOptions
 * @typedef {{ timebase: number, ntsc: boolean, fps: number }} NleRate
 * @typedef {{ kind: 'render', clip: string, frames: number, encoding: import('./nle-media.mjs').NleVideoEncoding }
 *   | { kind: 'copy', from: string }
 *   | { kind: 'link', from: string }
 *   | { kind: 'raster', from: string, src: string, w: number, h: number }
 *   | { kind: 'transcode', from: string, encoding: import('./nle-media.mjs').NleEncoding, segment?: { from: number, to: number, speed: number, seconds: number } }
 *   | { kind: 'stem', role: SoundRole, encoding: import('./nle-media.mjs').NleAudioEncoding }} NleMediaJob
 *   How a file is made: a clip rendered, a source cloned or pointed at, a still drawn to PNG, a source converted
 *   (`segment`: only those source seconds, at that speed, `seconds` long), a mixed stem
 * @typedef {{ id: string, name: string, path: string, job: NleMediaJob, durationFrames: number,
 *   video?: { w: number, h: number, alpha: boolean, still: boolean, fps?: number }, audio?: { channels: number, sampleRate: number } }} NleFile
 * @typedef {{ id: string, name: string, fileId: string, start: number, end: number, in: number, out: number, enabled: boolean,
 *   motion?: { scale: number, center: { h: number, v: number } }, gain?: number,
 *   levels?: { when: number, value: number }[], linkGroup?: string, sourceRow?: string }} NleClip
 *   Sequence frames [start, end), file frames [in, out); `gain` linear; `levels` its gain's keyframes (its fades),
 *   frames from the clip's first
 * @typedef {{ name: string, enabled: boolean, clips: NleClip[], sourceTrack?: number, role?: SoundRole }} NleTrack
 * @typedef {{ name: string, rate: NleRate, width: number, height: number, durationFrames: number, video: NleTrack[],
 *   audio: NleTrack[], files: NleFile[] }} NleTimeline
 */

/** The frame rates editors take. 23.976, 29.97 and 59.94 are xmeml's `ntsc` kind. */
export const NLE_FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

/** The editors' rate nearest `fps`. @param {number} fps */
export const nleFps = (fps) => NLE_FPS.reduce((best, f) => (Math.abs(f - fps) < Math.abs(best - fps) ? f : best), 30);

/** 29.97 / 59.94 / 23.976 → ntsc (a whole timebase, the true rate ×1000/1001). @param {number} fps @returns {NleRate} */
export function nleRate(fps) {
  const base = Math.max(1, Math.round(fps));
  const ntsc = Math.abs(fps - base) > 0.001 && Math.abs(fps - (base * 1000) / 1001) < 0.01;
  return ntsc ? { timebase: base, ntsc: true, fps: (base * 1000) / 1001 } : { timebase: base, ntsc: false, fps: base };
}

/** Seconds → sequence frames. @param {number} sec @param {NleRate} rate */
export const toFrame = (sec, rate) => Math.round(sec * rate.fps);

/** Film seconds [at, end) as frames, each edge rounded alone: clips back to back share their cut. @param {number} at @param {number} end @param {NleRate} rate */
export const frameSpan = (at, end, rate) => ({ start: toFrame(at, rate), end: toFrame(end, rate) });

/**
 * Overlapping items spread over lanes: by start, each into the first lane free again (`[start, end)`: back to back is
 * not overlapping). Returns each item's lane, in the items' order.
 * @param {readonly { start: number, end: number }[]} items
 */
export function allocateLanes(items) {
  const order = items.map((_, i) => i).sort((a, b) => items[a].start - items[b].start || a - b);
  /** @type {number[]} */
  const ends = [];
  const out = new Array(items.length).fill(0);
  for (const i of order) {
    let lane = ends.findIndex((end) => end <= items[i].start);
    if (lane < 0) { lane = ends.length; ends.push(items[i].end); } else ends[lane] = items[i].end;
    out[i] = lane;
  }
  return out;
}

const round6 = (/** @type {number} */ n) => { const r = Math.round(n * 1e6) / 1e6; return Object.is(r, -0) ? 0 : r; };

/**
 * A footage or still clip's place (fitted whole inside its `box`, or the stage, and centered: a picture with no CSS of
 * its own; `r` turns it about its center) as Basic Motion: the source's own pixels × scale %, its center moved from the
 * frame's by a share of the frame's width and height. A rotation or no size known → `bake`.
 * @param {{ w?: number, h?: number }} natural @param {{ w: number, h: number }} stage @param {FilmBox} [box]
 * @returns {{ kind: 'none' } | { kind: 'motion', motion: { scale: number, center: { h: number, v: number } } } | { kind: 'bake' }}
 */
export function containMotion(natural, stage, box) {
  const nw = natural.w ?? 0, nh = natural.h ?? 0;
  if (!(nw > 0 && nh > 0) || Math.abs(box?.r ?? 0) > 1e-6) return { kind: 'bake' };
  const rect = pictureRect('video', { w: nw, h: nh }, stage, box);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const scale = round6((Math.min(rect.w / nw, rect.h / nh)) * 100);
  const center = { h: round6((cx - stage.w / 2) / stage.w), v: round6((cy - stage.h / 2) / stage.h) };
  if (Math.abs(scale - 100) < 1e-4 && center.h === 0 && center.v === 0) return { kind: 'none' };
  return { kind: 'motion', motion: { scale, center } };
}

/**
 * Which stem a sound of the film goes in: a video's own sound is its footage's (what was recorded with the picture, not
 * a voice-over); any other sound by film-doc's soundRole (its folder, its name, else a voice). An export's stems and an
 * editor's sound tracks are named by it.
 * @param {string} src @returns {SoundRole}
 */
export const soundStem = (src) => (clipKind(src) === 'video' ? 'footage' : soundRole(src));

const extOf = (/** @type {string} */ path) => {
  const base = path.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};
/* the footage's sound first, under its picture, as an editor lays out the sound of what was shot */
const ROLE_ORDER = /** @type {SoundRole[]} */ (['footage', 'voice', 'sfx', 'music']);
const ROLE_NAME = { footage: 'Footage', voice: 'Voice', sfx: 'SFX', music: 'Music' };
const safeStem = (/** @type {string} */ name) => name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'clip';
const stemOf = (/** @type {string} */ src) => (src.split('/').pop() ?? src).replace(/\.[^.]+$/, '');

/** Stable source-row identity, independent of file names and export formats.
 * @param {readonly NleSound[]} sounds
 */
function sourceAudioGroups(sounds) {
  const tracks = new Set();
  for (const sound of sounds) {
    if (sound.track === undefined) throw new Error(`audio clip ${sound.id} has no source track`);
    tracks.add(sound.track);
  }
  return [...tracks].sort((a, b) => a - b)
    .map((track, i) => ({ key: `track-${track}`, name: `A${i + 1}`, sourceTrack: track }));
}

/**
 * The timeline, planned: tracks, each clip's frames, the file each points at and how that file is made.
 * Audio clips group by role by default; `audioTracks: 'source'` retains source rows and requires their indices.
 * @param {NleFilm} film @param {NlePlanOptions} opts @returns {NleTimeline}
 */
export function planNleTimeline(film, opts) {
  if (!opts.mediaPolicy.alphaVideo.alpha) throw new Error('editing-project clips require an alpha encoding');
  const rate = nleRate(opts.fps);
  const sourceTracks = opts.audioTracks === 'source';
  const { stage } = film;
  /** @type {NleFile[]} */
  const files = [];
  /** @type {Map<string, NleFile>} */
  const bySource = new Map();
  const names = new Set();
  let fileSeq = 0, clipSeq = 0;
  const total = Math.max(1, toFrame(film.duration, rate));

  const mediaPath = (/** @type {string} */ stem, /** @type {string} */ ext) => {
    let name = `${safeStem(stem)}.${ext}`;
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${safeStem(stem)} (${n}).${ext}`;
    names.add(name.toLowerCase());
    return { name, path: `${opts.mediaDir.replace(/\/$/, '')}/${name}` };
  };
  const addFile = (/** @type {Omit<NleFile, 'id'>} */ f) => { const file = { id: `file-${++fileSeq}`, ...f }; files.push(file); return file; };
  const clipId = () => `clipitem-${++clipSeq}`;

  /** Files whose length was measured; the others grow to what is used of them (a still has no length). */
  const measured = new Set();
  /** The clip needs the file up to frame `needed`: a measured file allows a frame of rounding, no more. */
  const reach = (/** @type {NleFile} */ file, /** @type {number} */ needed) => {
    if (!measured.has(file.id) || needed - file.durationFrames <= 1) file.durationFrames = Math.max(file.durationFrames, needed);
    return Math.min(needed, file.durationFrames);
  };

  /** A source (footage, still, sound) as one file of the folder, however many clips use it. */
  const sourceFile = (/** @type {{ src: string, path: string, facts: SourceFacts | null }} */ s, /** @type {'video' | 'still' | 'audio'} */ want, /** @type {number} */ minFrames) => {
    const hit = bySource.get(s.src);
    if (hit) return hit;
    const facts = s.facts ?? {};
    const ext = extOf(s.path);
    const stem = stemOf(s.src);
    const original = () => (opts.media === 'link'
      ? { name: s.path.split(/[\\/]/).pop() ?? stem, path: s.path, job: /** @type {NleMediaJob} */ ({ kind: 'link', from: s.path }) }
      : { ...mediaPath(stem, ext || 'mov'), job: /** @type {NleMediaJob} */ ({ kind: 'copy', from: s.path }) });
    /** @type {NleFile} */
    let file;
    if (want === 'still') {
      const w = facts.w ?? stage.w, h = facts.h ?? stage.h;
      const made = opts.mediaPolicy.stillCopy.has(ext) ? original() : { ...mediaPath(stem, 'png'), job: /** @type {NleMediaJob} */ ({ kind: 'raster', from: s.path, src: s.src, w, h }) };
      /* a converted still is PNG; a PNG, TIFF or PSD as it is may have alpha too; JPEG and BMP don't */
      file = addFile({ ...made, durationFrames: Math.max(1, minFrames), video: { w, h, alpha: !['jpg', 'jpeg', 'bmp'].includes(ext), still: true } });
    } else {
      const video = want === 'video' ? facts.hasVideo !== false : facts.hasVideo === true;
      const audio = facts.hasAudio ? { channels: facts.channels ?? 2, sampleRate: facts.sampleRate ?? 48_000 } : undefined;
      let made;
      if (video && opts.mediaPolicy.videoTranscode.has(ext)) {
        const encoding = facts.alpha ? opts.mediaPolicy.alphaVideo : opts.mediaPolicy.video;
        made = { ...mediaPath(stem, encoding.extension), job: /** @type {NleMediaJob} */ ({ kind: 'transcode', from: s.path, encoding }) };
      } else if (!video && !opts.mediaPolicy.audioCopy.has(ext)) {
        const encoding = opts.mediaPolicy.audio;
        made = { ...mediaPath(stem, encoding.extension), job: /** @type {NleMediaJob} */ ({ kind: 'transcode', from: s.path, encoding }) };
      } else made = original();
      const encoding = made.job.kind === 'transcode' ? made.job.encoding : null;
      const audioEncoding = encoding?.kind === 'video' ? encoding.audio : encoding;
      file = addFile({
        ...made,
        durationFrames: facts.duration ? Math.max(1, toFrame(facts.duration, rate)) : Math.max(1, minFrames),
        ...(video ? { video: { w: facts.w ?? stage.w, h: facts.h ?? stage.h, alpha: encoding?.kind === 'video' ? encoding.alpha : Boolean(facts.alpha), still: false, fps: facts.fps } } : {}),
        ...(audio ? { audio: audioEncoding ? { channels: audio.channels, sampleRate: audioEncoding.sampleRate } : audio } : {}),
      });
      if (facts.duration) measured.add(file.id);
    }
    bySource.set(s.src, file);
    return file;
  };

  /* ── pictures ── */
  /** @type {{ track: number, start: number, end: number, clip: NleClip }[]} */
  const visual = [];
  /** footage clips placed as they are, by picture id: their sound links to them */
  /** @type {Map<string, { clip: NleClip, file: NleFile, picture: NlePicture }>} */
  const footage = new Map();
  for (const p of film.pictures) {
    const span = frameSpan(p.at, p.end, rate);
    const len = span.end - span.start;
    if (len <= 0) continue;
    const link = sourceTracks && p.kind === 'video' ? { linkGroup: `footage-${p.id}` } : {};
    const bake = () => {
      const encoding = opts.mediaPolicy.alphaVideo;
      const file = addFile({ ...mediaPath(p.id, encoding.extension), job: { kind: 'render', clip: p.id, frames: len, encoding }, durationFrames: len, video: { w: stage.w, h: stage.h, alpha: true, still: false } });
      visual.push({ track: p.track, ...span, clip: { id: clipId(), name: p.id, fileId: file.id, ...span, in: 0, out: len, enabled: !p.hidden, ...link } });
    };
    /* a clip with a look of its own (the film's CSS: a crop, round corners) is drawn as the film draws it */
    if (p.kind === 'page' || p.styled || p.faded || !p.facts || (p.kind === 'video' && Math.abs(p.speed - 1) > 1e-6)) { bake(); continue; }
    const placement = containMotion(p.facts, stage, p.box);
    if (placement.kind === 'bake') { bake(); continue; }
    const inFrame = p.kind === 'still' ? 0 : toFrame(p.from, rate);
    const file = sourceFile(p, p.kind, inFrame + len);
    const out = reach(file, inFrame + len);
    if (out <= inFrame) continue;
    /** @type {NleClip} */
    const clip = {
      id: clipId(), name: p.id, fileId: file.id, start: span.start, end: span.start + out - inFrame, in: inFrame, out, enabled: !p.hidden,
      ...link,
      ...(placement.kind === 'motion' ? { motion: placement.motion } : {}),
    };
    if (p.kind === 'video') footage.set(p.id, { clip, file, picture: p });
    visual.push({ track: p.track, start: clip.start, end: clip.end, clip });
  }
  /** @type {NleTrack[]} */
  const video = [];
  for (const index of [...new Set(visual.map((v) => v.track))].sort((a, b) => b - a)) {
    const items = visual.filter((v) => v.track === index).sort((a, b) => a.start - b.start);
    const lanes = allocateLanes(items);
    const count = Math.max(0, ...lanes) + 1;
    for (let lane = 0; lane < count; lane++) {
      const clips = items.filter((_, i) => lanes[i] === lane).map((v) => v.clip);
      video.push({ name: `Track ${index + 1}${count > 1 ? ` (${lane + 1})` : ''}`, enabled: clips.some((c) => c.enabled), clips });
    }
  }

  /* ── sound ── */
  /** @type {NleTrack[]} */
  const audio = [];
  if (opts.audio === 'stems') {
    for (const role of ROLE_ORDER) {
      if (!opts.stems?.includes(role)) continue;
      const encoding = opts.mediaPolicy.audio;
      const file = addFile({ ...mediaPath(`${opts.title || 'Film'} - ${role}`, encoding.extension), job: { kind: 'stem', role, encoding },
        durationFrames: total, audio: { channels: 2, sampleRate: encoding.sampleRate } });
      audio.push({ name: ROLE_NAME[role], enabled: true, role, clips: [{ id: clipId(), name: `${ROLE_NAME[role]} stem`, fileId: file.id, start: 0, end: total, in: 0, out: total, enabled: true }] });
    }
  } else {
    /** @type {{ key: string, name: string, sourceTrack?: number }[]} */
    const groups = sourceTracks
      ? sourceAudioGroups(film.sounds)
      : ROLE_ORDER.map((role) => ({ key: role, name: ROLE_NAME[role] }));
    /** @type {Map<string, { start: number, end: number, clip: NleClip }[]>} */
    const byGroup = new Map();
    for (const s of film.sounds) {
      const length = (s.to - s.from) / s.speed;
      if (!(length > 0)) continue;
      const span = frameSpan(s.at, s.at + length, rate);
      const len = span.end - span.start;
      if (len <= 0) continue;
      const linked = s.picture ? footage.get(s.picture) : undefined;
      const own = linked && Math.abs(s.speed - 1) < 1e-6 && Math.abs(linked.picture.from - s.from) < 0.002 && Math.abs(linked.picture.at - s.at) < 0.002;
      /** @type {NleFile} */
      let file;
      let inFrame;
      const faded = Boolean(s.fade && (s.fade[0] > 0 || s.fade[1] > 0));
      if (Math.abs(s.speed - 1) > 1e-6 || faded) {
        /* another speed: an editor would play the source at its own speed, so the part played comes slowed or sped
           (its pitch kept), as the film plays it, in the adapter's audio encoding, exactly as long as its clip: the source seconds
           its frames take, as the picture of a clip at another speed is rendered. A sound that fades too: its
           keyframes then count from the file's first frame, the clip's */
        const named = `${stemOf(s.src)}${Math.abs(s.speed - 1) > 1e-6 ? ` x${round6(s.speed)}` : ''}${faded ? ' fade' : ''}`;
        const encoding = opts.mediaPolicy.audio;
        file = addFile({
          ...mediaPath(named, encoding.extension), durationFrames: len,
          job: { kind: 'transcode', from: s.path, encoding, segment: { from: s.from, to: s.from + (len / rate.fps) * s.speed, speed: s.speed, seconds: len / rate.fps } },
          audio: { channels: s.facts?.channels ?? 2, sampleRate: encoding.sampleRate },
        });
        inFrame = 0;
      } else {
        inFrame = toFrame(s.from, rate);
        file = own && linked ? linked.file : sourceFile(s, 'audio', inFrame + len);
      }
      if (!file.audio) continue;
      const out = reach(file, inFrame + len);
      if (out <= inFrame) continue;
      /** @type {NleClip} */
      const clip = {
        id: clipId(), name: s.id, fileId: file.id, start: span.start, end: span.start + out - inFrame, in: inFrame, out,
        enabled: s.enabled,
        ...(sourceTracks && s.sourceRow ? { sourceRow: s.sourceRow } : {}),
        ...(Math.abs(s.volume - 1) > 1e-6 ? { gain: round6(Math.min(3.98109, s.volume)) } : {}),
      };
      if (faded && s.fade) clip.levels = fadeKeyframes(s.fade, out - inFrame, Math.min(3.98109, s.volume), rate);
      if (own && linked && !sourceTracks) {
        linked.clip.linkGroup = `link-${linked.clip.id}`;
        clip.linkGroup = linked.clip.linkGroup;
      }
      if (sourceTracks && s.picture) clip.linkGroup = `footage-${s.picture}`;
      const group = sourceTracks ? `track-${s.track}` : s.role;
      const list = byGroup.get(group) ?? [];
      list.push({ start: clip.start, end: clip.end, clip });
      byGroup.set(group, list);
    }
    for (const group of groups) {
      const items = (byGroup.get(group.key) ?? []).sort((a, b) => a.start - b.start);
      if (!items.length) continue;
      const lanes = allocateLanes(items);
      const count = Math.max(0, ...lanes) + 1;
      for (let lane = 0; lane < count; lane++) {
        const clips = items.filter((_, i) => lanes[i] === lane).map((v) => v.clip);
        audio.push({ name: count > 1 ? `${group.name} ${lane + 1}` : group.name, enabled: clips.some((c) => c.enabled), clips,
          ...(group.sourceTrack !== undefined ? { sourceTrack: group.sourceTrack } : {}) });
      }
    }
  }

  const end = Math.max(total, ...video.flatMap((t) => t.clips.map((c) => c.end)), ...audio.flatMap((t) => t.clips.map((c) => c.end)));
  return { name: opts.title || 'OpenFilm', rate, width: stage.w, height: stage.h, durationFrames: end, video, audio, files };
}

/**
 * A sound's fades as Audio Levels keyframes over its `frames`: silent at its first frame, its level `gain` once faded
 * in, again where it starts to fade out, silent at its end. @param {[number, number]} fade film seconds
 * @param {number} frames @param {number} gain @param {NleRate} rate
 */
export function fadeKeyframes(fade, frames, gain, rate) {
  const fin = Math.min(frames, toFrame(fade[0], rate)), fout = Math.min(frames - fin, toFrame(fade[1], rate));
  const g = round6(gain);
  /** @type {{ when: number, value: number }[]} */
  const keys = [];
  if (fin > 0) keys.push({ when: 0, value: 0 }, { when: fin, value: g });
  else keys.push({ when: 0, value: g });
  if (fout > 0) {
    if (frames - fout > (keys.at(-1)?.when ?? 0)) keys.push({ when: frames - fout, value: g });
    keys.push({ when: frames, value: 0 });
  }
  return keys;
}

/* ── the sources ────────────────────────────────────────────────────────── */

/**
 * One ffprobe of a source: its length, picture size, rate, sound channels, and whether its picture has alpha. What
 * can't be read is missing.
 * @param {string} path @returns {Promise<SourceFacts>}
 */
export function probeSource(path) {
  return new Promise((done) => {
    const proc = spawn('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration,format_name:stream=codec_type,width,height,avg_frame_rate,r_frame_rate,channels,sample_rate,pix_fmt:stream_tags=alpha_mode',
      '-of', 'json', path], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.on('error', () => done({}));
    proc.on('close', () => {
      try {
        /** @type {{ format?: { duration?: string, format_name?: string }, streams?: { codec_type?: string, width?: number, height?: number, avg_frame_rate?: string, r_frame_rate?: string, channels?: number, sample_rate?: string, pix_fmt?: string, tags?: { alpha_mode?: string } }[] }} */
        const json = JSON.parse(out);
        const streams = json.streams ?? [];
        const v = streams.find((s) => s.codec_type === 'video');
        const a = streams.find((s) => s.codec_type === 'audio');
        const sec = Number(json.format?.duration ?? NaN);
        const still = /image|png|mjpeg|jpeg|bmp|tiff/.test(json.format?.format_name ?? '');
        const fr = (/** @type {string | undefined} */ raw) => { const [n, d] = (raw ?? '').split('/').map(Number); return n && d ? n / d : undefined; };
        const fps = fr(v?.avg_frame_rate) ?? fr(v?.r_frame_rate);
        done({
          ...(v?.width ? { w: v.width } : {}),
          ...(v?.height ? { h: v.height } : {}),
          ...(Number.isFinite(sec) && sec > 0 && !still ? { duration: sec } : {}),
          ...(fps && fps < 500 && !still ? { fps } : {}),
          hasVideo: Boolean(v),
          hasAudio: Boolean(a),
          ...(a?.channels ? { channels: a.channels } : {}),
          ...(a?.sample_rate ? { sampleRate: Number(a.sample_rate) } : {}),
          alpha: v?.tags?.alpha_mode === '1' || /^(yuva|rgba|bgra|argb|abgr|gbrap|ya)/.test(v?.pix_fmt ?? ''),
        });
      } catch {
        done({});
      }
    });
  });
}
