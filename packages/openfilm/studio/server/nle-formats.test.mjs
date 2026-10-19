import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { NLE_FORMATS, nleFormat, checkedNleDocuments } from './nle-formats.mjs';
import { planNleTimeline } from './nle.mjs';
import { xmemlDocument } from './xmeml.mjs';
import { fcpxmlDocument } from './fcpxml.mjs';
import { filmSubtitleSrt } from './film-subtitle.mjs';

const root = join(tmpdir(), 'of-format-contract');
const options = { title: 'Film & edit', root, folder: join(root, 'Film & edit (2)'),
  cues: [{ text: 'Hello & goodbye', startMs: 100, durMs: 900 }] };
const facts = { w: 320, h: 180, duration: 10, hasVideo: true, hasAudio: true, channels: 2, sampleRate: 48000, fps: 25 };
const film = {
  stage: { w: 320, h: 180 }, duration: 3,
  pictures: [{ id: 'shot', kind: 'video', src: 'shot.mp4', path: join(root, 'shot.mp4'),
    at: 0, end: 3, from: 1, speed: 1, track: 0, hidden: false, facts }],
  sounds: [{ id: 'shot', src: 'shot.mp4', path: join(root, 'shot.mp4'), at: 0, from: 1, to: 4,
    speed: 1, volume: 0.5, enabled: true, role: 'footage', picture: 'shot', track: 0, facts }],
};

function plan(format, audio = 'clips') {
  return planNleTimeline(film, { title: options.title, fps: 29.97, audio, media: 'copy',
    mediaDir: join(options.folder, 'media'), audioTracks: format.audioTracks, mediaPolicy: format.mediaPolicy, stems: ['footage'] });
}

test('format lookup defaults to Editor XML and rejects unknown or inherited values', () => {
  assert.equal(nleFormat(), NLE_FORMATS.xml);
  for (const id of [null, '', 'unknown', '__proto__', 'constructor', 'toString', {}, 0]) assert.equal(nleFormat(id), undefined);
  assert.equal(NLE_FORMATS.fcpxml.audioTracks, 'source');
  assert.equal(NLE_FORMATS.fcpxml.strictSubtitles, true);
  for (const id of ['xml', 'jianying', 'capcut']) {
    assert.equal(NLE_FORMATS[id].audioTracks, 'roles');
    assert.equal(NLE_FORMATS[id].strictSubtitles, false);
  }
});

test('XML adapters preserve serializer bytes and sidecars with the project document first', () => {
  for (const [id, render] of [['xml', xmemlDocument], ['fcpxml', (t) => fcpxmlDocument(t, { cues: options.cues })]]) {
    const format = nleFormat(id);
    const timeline = plan(format);
    assert.deepEqual(format.serialize(timeline, options), [
      { name: `${options.title}.${id}`, text: render(timeline) },
      { name: `${options.title}.srt`, text: filmSubtitleSrt(options.cues) },
    ]);
    assert.equal(format.serialize(timeline, { ...options, cues: [] }).length, 1);
    assert.equal(format.draftApp, undefined);
  }
});

test('draft adapters retain app identities, final folder paths and matching Windows/macOS content', () => {
  for (const [app, appId] of [['jianying', 3704], ['capcut', 359289]]) {
    const format = nleFormat(app);
    const timeline = plan(format);
    const documents = format.serialize(timeline, options);
    assert.equal(format.draftApp, app);
    assert.deepEqual(documents.map((d) => d.name), ['draft_info.json', 'draft_content.json', 'draft_meta_info.json']);
    assert.equal(documents[0].text, documents[1].text);
    const info = JSON.parse(documents[0].text), meta = JSON.parse(documents[2].text);
    assert.equal(info.platform.app_id, appId);
    assert.equal(info.name, basename(options.folder));
    assert.equal(meta.draft_fold_path, options.folder);
    assert.equal(meta.draft_root_path, options.root);
    assert.equal(meta.draft_id, info.id);
    assert.equal(info.materials.texts.length, 1);
    assert.equal(info.materials.videos[0].path, timeline.files[0].path);
    assert.equal(info.tracks.find((t) => t.type === 'video').segments[0].volume, 0.5);
    const withoutCues = JSON.parse(format.serialize(timeline, { ...options, cues: [] })[0].text);
    assert.equal(withoutCues.materials.texts.length, 0);
  }
});

test('every adapter serializes clips and stems without mutating the shared plan or cues', () => {
  for (const format of Object.values(NLE_FORMATS)) for (const audio of ['clips', 'stems']) {
    const timeline = plan(format, audio);
    const before = structuredClone({ timeline, options });
    const documents = format.serialize(timeline, options);
    assert.ok(documents.length);
    assert.equal(new Set(documents.map((d) => d.name)).size, documents.length);
    for (const document of documents) {
      assert.equal(basename(document.name), document.name);
      assert.ok(document.text.length);
    }
    assert.deepEqual({ timeline, options }, before);
  }
});

test('document validation rejects traversal, media collisions and names that overwrite on desktop filesystems', () => {
  const document = (name) => ({ name, text: '{}' });
  for (const name of ['', '.', '..', '../outside.json', '/tmp/outside.json', 'nested/project.json',
    'nested\\project.json', 'C:project.json', 'MEDIA', 'project.json.', 'project.json ', 'NUL.json', 'project\u0000.json']) {
    assert.throws(() => checkedNleDocuments([document('entry.json'), document(name)]), /invalid.*document name/);
  }
  assert.throws(() => checkedNleDocuments([]), /no entry document/);
  assert.throws(() => checkedNleDocuments([document('Film.xml'), document('film.XML')]), /duplicate.*document name/);
  assert.throws(() => checkedNleDocuments([{ name: 'Film.xml', text: null }]), /no text/);
  const valid = [document('Film & edit.fcpxml'), document('剪映.json')];
  assert.equal(checkedNleDocuments(valid), valid);
});

test('XML adapters keep project titles that are reserved device names usable across desktops', () => {
  for (const id of ['xml', 'fcpxml']) {
    const format = nleFormat(id);
    const documents = format.serialize(plan(format), { ...options, title: 'CON' });
    assert.deepEqual(documents.map((d) => d.name), [`_CON.${id}`, '_CON.srt']);
    assert.equal(checkedNleDocuments(documents), documents);
  }
});
