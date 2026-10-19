import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentsDir, chatDir, describePaths, loadChat, logsDir, openLog, readLog, refsDir, saveAttachment, saveRefImage, saveSessions, saveTurn, unsavedTurns } from './chat-store.mjs';

const project = () => mkdtempSync(join(tmpdir(), 'of-chat-'));
const turn = (id, createdAt) => ({ turn: { id, createdAt, sessionId: 's1', prompt: id }, items: [{ kind: 'text', text: id }] });
/** a turn's log is written through a stream: wait until what a reader needs is on disk (a slow runner needs more than a fixed pause) */
async function until(fn, ok) {
  for (let i = 0; i < 500; i += 1) {
    const value = fn();
    if (ok(value)) return value;
    await new Promise((done) => setTimeout(done, 10));
  }
  return fn();
}
const logOnDisk = (dir, id, lines = 1) => until(() => readLog(dir, id), (read) => Boolean(read && read.events.length >= lines));

test('a project with no chat yet has none; what is saved comes back, the turns in the order they were asked', () => {
  const dir = project();
  assert.deepEqual(loadChat(dir), { sessions: [], last: null, turns: [] });
  saveSessions(dir, { sessions: [{ id: 's1', title: 'One', createdAt: '2026-10-07T00:00:00Z' }], last: 's1' });
  saveTurn(dir, turn('t2', '2026-10-07T00:00:02Z'));
  saveTurn(dir, turn('t1', '2026-10-07T00:00:01Z'));
  const chat = loadChat(dir);
  assert.equal(chat.last, 's1');
  assert.deepEqual(chat.sessions.map((s) => s.id), ['s1']);
  assert.deepEqual(chat.turns.map((t) => t.turn.id), ['t1', 't2']);
  saveTurn(dir, { ...turn('t1', '2026-10-07T00:00:01Z'), items: [] });
  assert.deepEqual(loadChat(dir).turns.find((t) => t.turn.id === 't1').items, [], 'a turn saved again replaces itself');
});

test('a turn is written to its log as it happens and read back, a broken last line left out', async () => {
  const dir = project();
  const log = openLog(dir, 't1');
  log.write('prompt', { text: 'hello' });
  log.write('update', { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } });
  log.write('done', { ok: true, stopReason: 'end_turn' });
  log.end();
  await logOnDisk(dir, 't1', 3);
  appendFileSync(join(logsDir(dir), 't1.jsonl'), '{"t":1,"kind":"upd');
  const read = readLog(dir, 't1');
  assert.deepEqual(read.events.map((e) => e.kind), ['prompt', 'update', 'done']);
  assert.ok(read.events.every((e) => typeof e.t === 'number'));
  assert.equal(read.cut, false);
});

test('a local turn\'s id (local:…) names a file any system allows', async () => {
  const dir = project();
  saveTurn(dir, turn('local:abc123', '2026-10-07T00:00:00Z'));
  const log = openLog(dir, 'local:abc123');
  log.write('prompt', {});
  log.end();
  const read = await logOnDisk(dir, 'local:abc123');
  assert.deepEqual(loadChat(dir).turns.map((t) => t.turn.id), ['local:abc123']);
  assert.ok(read.file.endsWith('local-abc123.jsonl'));
});

test('ids that are not ids name no file', () => {
  const dir = project();
  assert.throws(() => saveTurn(dir, turn('../escape', 'x')));
  assert.equal(readLog(dir, '../../etc/passwd'), null);
  const log = openLog(dir, 'a/b');
  log.write('prompt', {});
  log.end();
  assert.equal(readLog(dir, 'a'), null);
});

test('sessions are written whole, never half', () => {
  const dir = project();
  saveSessions(dir, { sessions: [{ id: 's1', createdAt: 'x' }], last: null });
  const text = readFileSync(join(chatDir(dir), 'sessions.json'), 'utf8');
  assert.equal(JSON.parse(text).version, 1);
});

test('a turn\'s model requests are kept beside its log and read back with it', async () => {
  const dir = project();
  const log = openLog(dir, 'local:m1', () => {}, '.model');
  log.write('call', { startedAt: 1, ms: 2, prefix: 0, messages: [{ role: 'user', content: 'hi' }], params: { model: 'm' }, response: null, error: null });
  log.end();
  assert.equal(readLog(dir, 'local:m1'), null, 'no log of its own, nothing to show');
  const events = openLog(dir, 'local:m1');
  events.write('prompt', { text: 'hi' });
  events.end();
  const read = await until(() => readLog(dir, 'local:m1'), (r) => Boolean(r && r.events.length >= 1 && r.calls.length >= 1));
  assert.deepEqual(read.calls.map((c) => c.messages[0].content), ['hi']);
  assert.ok(read.file.endsWith('local-m1.jsonl'));
});

test('a reference\'s picture is kept as .film/refs/<turn>-<n>.jpg, and nothing but a JPEG under a name made here', () => {
  const dir = project();
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  assert.deepEqual(saveRefImage(dir, 'local:abc123', 2, jpeg), { path: '.film/refs/local-abc123-2.jpg' });
  assert.deepEqual([...readFileSync(join(refsDir(dir), 'local-abc123-2.jpg'))], [...jpeg]);
  assert.equal(saveRefImage(dir, 'local:abc123', 3, jpeg.buffer).path, '.film/refs/local-abc123-3.jpg');
  assert.throws(() => saveRefImage(dir, '../../etc', 1, jpeg), /not a turn/);
  assert.throws(() => saveRefImage(dir, 'local:a/b', 1, jpeg), /not a turn/);
  assert.throws(() => saveRefImage(dir, 'local:abc', 0, jpeg), /reference number/);
  assert.throws(() => saveRefImage(dir, 'local:abc', 1.5, jpeg), /reference number/);
  assert.throws(() => saveRefImage(dir, 'local:abc', 1, new Uint8Array([0x89, 0x50, 0x4e, 0x47])), /not a JPEG/);
  assert.throws(() => saveRefImage(dir, 'local:abc', 1, 'not bytes'), /not a picture/);
});

test('a pasted file is kept in .film/attachments under its own name, cleaned, and never anywhere else', () => {
  const dir = project();
  const bytes = new Uint8Array([1, 2, 3]);
  assert.deepEqual(saveAttachment(dir, 'image.png', bytes), { path: '.film/attachments/image.png' });
  assert.deepEqual([...readFileSync(join(attachmentsDir(dir), 'image.png'))], [1, 2, 3]);
  assert.equal(saveAttachment(dir, 'image.png', bytes.buffer).path, '.film/attachments/image 2.png', 'a name already there is not written over');
  assert.equal(saveAttachment(dir, 'image.png', bytes).path, '.film/attachments/image 3.png');
  assert.equal(saveAttachment(dir, '../../etc/passwd', bytes).path, '.film/attachments/passwd');
  assert.equal(saveAttachment(dir, '..\\..\\win.ini', bytes).path, '.film/attachments/win.ini');
  assert.equal(saveAttachment(dir, '.hidden', bytes).path, '.film/attachments/hidden');
  assert.equal(saveAttachment(dir, '', bytes).path, '.film/attachments/file');
  assert.throws(() => saveAttachment(dir, 'empty.txt', new Uint8Array()), /empty/);
  assert.throws(() => saveAttachment(dir, 'x.txt', 'not bytes'), /empty/);
});

test('a path dragged in is said to be a file (with its size) or a folder, where it is; one not there is said so', () => {
  const dir = project();
  const folder = join(dir, 'Footage');
  mkdirSync(folder);
  const clip = join(folder, 'a.mp4');
  writeFileSync(clip, 'abcd');
  assert.deepEqual(describePaths([clip, folder, join(dir, 'gone.mp4'), 'relative.mp4', 7]), [
    { path: clip, folder: false, size: 4 },
    { path: folder, folder: true },
    { path: join(dir, 'gone.mp4'), error: 'That file is not there any more.' },
    { path: 'relative.mp4', error: 'That is not a file.' },
    { path: '7', error: 'That is not a file.' },
  ]);
  assert.deepEqual(describePaths('not a list'), []);
});

test('a log not grown since the sizes a reader has is not read again', async () => {
  const dir = project();
  const log = openLog(dir, 't2');
  log.write('prompt', { text: 'hello' });
  const first = await logOnDisk(dir, 't2', 1);
  assert.deepEqual(readLog(dir, 't2', { unless: { size: first.size, callsSize: first.callsSize } }), { same: true });
  log.write('done', { ok: true });
  log.end();
  await logOnDisk(dir, 't2', 2);
  assert.deepEqual(readLog(dir, 't2', { unless: { size: first.size, callsSize: first.callsSize } }).events.map((e) => e.kind), ['prompt', 'done']);
});

test('a turn with a log and no saved record is found with its events; a saved one, one running, one with no meta are not', async () => {
  const dir = project();
  const write = (id, meta) => { const log = openLog(dir, id); log.write('prompt', { text: 'hi', ...(meta ? { meta } : {}) }); log.write('update', { update: { sessionUpdate: 'agent_message_chunk' } }); log.end(); };
  write('local:lost1', { turnId: 'local:lost1', sessionId: 's1' });
  write('local:kept1', { turnId: 'local:kept1', sessionId: 's1' });
  write('local:busy1', { turnId: 'local:busy1', sessionId: 's1' });
  write('local:bare1', null);
  saveTurn(dir, turn('local:kept1', '2026-10-12T00:00:00Z'));
  await Promise.all(['local:lost1', 'local:kept1', 'local:busy1', 'local:bare1'].map((id) => logOnDisk(dir, id, 2)));
  const found = unsavedTurns(dir, { except: ['local:busy1'] });
  assert.deepEqual(found.map((f) => f.turnId), ['local:lost1']);
  assert.deepEqual(found[0].events.map((e) => e.kind), ['prompt', 'update']);
});
