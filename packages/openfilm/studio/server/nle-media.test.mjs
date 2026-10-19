import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planNleTimeline } from './nle.mjs';
import { NLE_MEDIA_POLICY } from './nle-media.mjs';
import { NLE_FORMATS } from './nle-formats.mjs';

const facts = { w: 320, h: 180, duration: 1, hasVideo: true, hasAudio: false };
const film = {
  stage: { w: 320, h: 180 }, duration: 1,
  pictures: ['shot.webm', 'still.png'].map((src, track) => ({ id: src, src, path: `/source/${src}`,
    kind: track ? 'still' : 'video', at: 0, end: 1, from: 0, speed: 1, track, hidden: false, facts })),
  sounds: [{ id: 'voice', src: 'voice.wav', path: '/source/voice.wav', at: 0, from: 0, to: 1, speed: 1,
    volume: 1, enabled: true, role: 'voice', facts: { duration: 1, hasAudio: true } }],
};
const options = { title: 'Policy', fps: 25, audio: 'clips', mediaDir: '/out/media' };
const jobs = (timeline) => Object.fromEntries(timeline.files.map((file) => [file.job.from, file.job.kind]));

for (const media of ['copy', 'link']) test(`adapter compatibility controls source preparation in ${media} mode`, () => {
  const before = structuredClone(film);
  const original = planNleTimeline(film, { ...options, media, mediaPolicy: NLE_MEDIA_POLICY });
  assert.deepEqual(jobs(original), { '/source/shot.webm': 'transcode', '/source/still.png': media, '/source/voice.wav': media });
  const mediaPolicy = { ...NLE_MEDIA_POLICY, videoTranscode: new Set(), stillCopy: new Set(), audioCopy: new Set() };
  const changed = planNleTimeline(film, { ...options, media, mediaPolicy });
  assert.deepEqual(jobs(changed), { '/source/shot.webm': media, '/source/still.png': 'raster', '/source/voice.wav': 'transcode' });
  for (const file of changed.files) {
    if (file.job.kind === 'link') assert.equal(file.path, file.job.from);
    else assert.ok(file.path.startsWith(options.mediaDir + '/'));
  }
  assert.deepEqual(film, before);
  assert.equal(NLE_MEDIA_POLICY.videoTranscode.has('webm'), true, 'a custom policy leaves shared compatibility unchanged');
});

test('existing formats explicitly retain the same source compatibility', () => {
  for (const format of Object.values(NLE_FORMATS)) assert.equal(format.mediaPolicy, NLE_MEDIA_POLICY);
});

test('encoding profiles determine file extensions, jobs and metadata for sources, renders, segments and stems', () => {
  const audio = { kind: 'audio', extension: 'aiff', codec: 'pcm_s24be', args: [], sampleRate: 44_100 };
  const video = { ...NLE_MEDIA_POLICY.alphaVideo, audio };
  const mediaPolicy = { ...NLE_MEDIA_POLICY, video, alphaVideo: video, audioCopy: new Set(), audio };
  const source = { ...film, pictures: [...film.pictures, { ...film.pictures[0], id: 'page', src: 'page.html', kind: 'page', facts: null }],
    sounds: [...film.sounds, { ...film.sounds[0], id: 'slow', speed: 0.5 }, { ...film.sounds[0], id: 'fade', fade: [0.2, 0] }] };
  const plan = planNleTimeline(source, { ...options, media: 'copy', mediaPolicy });
  const converted = plan.files.find((f) => f.job.kind === 'transcode' && f.video);
  assert.equal(converted.job.encoding, video);
  assert.equal(converted.video.alpha, true);
  const render = plan.files.find((f) => f.job.kind === 'render');
  assert.equal(render.job.encoding, video);
  for (const file of plan.files.filter((f) => f.audio)) {
    assert.equal(file.audio.sampleRate, 44_100);
    if (file.job.encoding.kind === 'audio') assert.ok(file.path.endsWith('.aiff'));
  }
  assert.equal(plan.files.filter((f) => f.job.segment).length, 2, 'speed and fade processing both use the audio profile');
  const stems = planNleTimeline(source, { ...options, media: 'copy', audio: 'stems', stems: ['voice'], mediaPolicy });
  const stem = stems.files.find((f) => f.job.kind === 'stem');
  assert.equal(stem.job.encoding, audio);
  assert.equal(stem.audio.sampleRate, 44_100);
  assert.ok(stem.path.endsWith('.aiff'));
  assert.throws(() => planNleTimeline(source, { ...options, media: 'copy',
    mediaPolicy: { ...mediaPolicy, alphaVideo: { ...video, alpha: false } } }), /require an alpha encoding/);
});
