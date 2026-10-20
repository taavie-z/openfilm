import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { getPriority, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encoders, hardwareEncoder } from './encoders.mjs';
import { filmHtml } from './film-doc.mjs';
import { defaultWorkers, machine, outOfMemory, render } from './render.mjs';

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('the render command accepts decimal frame rates and still rejects invalid rates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'of-render-fps-options-'));
  try {
    const cli = fileURLToPath(new URL('../bin/openfilm.mjs', import.meta.url));
    for (const fps of ['1', '23.976', '29.97', '59.94', String(30000 / 1001), '240']) {
      const result = spawnSync(process.execPath, [cli, 'render', `--fps=${fps}`], { cwd: dir, encoding: 'utf8' });
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /is not in a project/, `--fps ${fps} passes option validation`);
    }
    for (const fps of ['0', '-1', '0.99', '240.1', 'NaN', 'Infinity']) {
      const result = spawnSync(process.execPath, [cli, 'render', `--fps=${fps}`], { cwd: dir, encoding: 'utf8' });
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /--fps is a number from 1 to 240/, `--fps ${fps} is rejected`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the render command renders 29.97 as exactly 30000/1001, and keeps another decimal rate, through encoding, blur and parallel parts', { skip: !hasFfmpeg && 'no ffmpeg', timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'of-render-fractional-'));
  try {
    writeFileSync(join(dir, 'p.html'), '<!doctype html><body style="margin:0"><script>window.film = { duration: 0.5, width: 320, height: 180, frame(t) { document.body.style.background = `hsl(${t * 360}, 80%, 50%)`; } };</script>');
    writeFileSync(join(dir, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'p', src: 'p.html', at: 0, time: [0, 0.5] }] }] }));
    mkdirSync(join(dir, '.film'));
    writeFileSync(join(dir, '.film', 'opened'), '');
    const cli = fileURLToPath(new URL('../bin/openfilm.mjs', import.meta.url));
    for (const [fps, rate, workers, samples] of [[29.97, '30000/1001', 1, 1], [30000 / 1001, '30000/1001', 2, 2], [12.5, '25/2', 1, 1]]) {
      const out = join(dir, `${fps}.mp4`);
      execFileSync(process.execPath, [cli, 'render', '--fps', String(fps), '--workers', String(workers), '--samples', String(samples), '--out', out], { cwd: dir, timeout: 60_000, stdio: 'pipe' });
      const { streams: [video] } = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,avg_frame_rate,nb_read_frames', '-of', 'json', out], { encoding: 'utf8' }));
      assert.equal(video.r_frame_rate, rate);
      assert.equal(video.avg_frame_rate, rate);
      assert.equal(Number(video.nb_read_frames), Math.round(0.5 * fps));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a render with no format of its own encodes on the graphics chip when it can: H.264 for an MP4, ProRes for a MOV', { skip: !hasFfmpeg && 'no ffmpeg', timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'of-render-chip-'));
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><body style="margin:0"><div id="box" style="width:320px;height:180px"></div><script>'
      + 'window.film = { duration: 1, width: 320, height: 180, frame(t) { document.getElementById("box").style.background = `hsl(${t * 360}, 80%, 50%)`; } };</script>');
    const have = await encoders();
    const quiet = { workers: 1, silent: true, onProgress() {} };
    const mp4 = await render([dir, '0-0.5'], { ...quiet, out: join(dir, 'chip.mp4') });
    assert.equal(mp4.encoder, (await hardwareEncoder('h264', have)) ?? 'libx264');
    assert.match(mp4.lines[1], new RegExp(` · ${mp4.encoder} · `), 'the summary says which encoder');
    const soft = await render([dir, '0-0.5'], { ...quiet, out: join(dir, 'soft.mp4'), hardware: false });
    assert.equal(soft.encoder, 'libx264', 'hardware: false keeps the processor\'s');
    const mov = await render([dir, '0-0.5'], { ...quiet, out: join(dir, 'chip.mov'), alpha: true });
    assert.equal(mov.encoder, (await hardwareEncoder('prores', have)) ?? 'prores_ks');
    assert.equal(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,profile', '-of', 'csv=p=0', mov.out]).toString().trim(), 'prores,4444');
    const frames = (file) => parseInt(execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file]).toString(), 10);
    assert.deepEqual([mp4.out, soft.out, mov.out].map(frames), [15, 15, 15]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an encoder that fails to start fails the render with ffmpeg\'s error, instead of waiting forever', { skip: !hasFfmpeg && 'no ffmpeg', timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'of-render-fails-'));
  try {
    /* noise: frames too big for the pipe to take while no one reads it */
    writeFileSync(join(dir, 'index.html'), '<!doctype html><body style="margin:0"><canvas width="1280" height="720"></canvas><script>'
      + 'const c = document.querySelector("canvas").getContext("2d"), img = c.createImageData(1280, 720);'
      + 'window.film = { duration: 1, width: 1280, height: 720, frame(t) { let s = 1 + Math.round(t * 30);'
      + 'for (let i = 0; i < img.data.length; i++) { s = (s * 1103515245 + 12345) % 2147483648; img.data[i] = i % 4 === 3 ? 255 : s & 255; }'
      + 'c.putImageData(img, 0, 0); } };</script>');
    await assert.rejects(render([dir], { out: join(dir, 'out.mp4'), workers: 1, format: { video: ['-c:v', 'no_such_encoder'] } }), /^Error: ffmpeg: .*no_such_encoder/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed encode is the error told, even when its parts folder cannot be removed', { skip: (!hasFfmpeg && 'no ffmpeg') || (process.platform === 'win32' && 'no read-only folders') || (process.getuid?.() === 0 && 'root removes anything'), timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'of-render-held-'));
  /* the folder this render encodes its parts in, made read-only with a file in it: as Windows holds the files of an
     encoder still exiting, the folder cannot be removed */
  const work = join(dir, '.film', 'cache', 'render', `.parts-${process.pid}`);
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><body><script>window.film = { duration: 1, width: 320, height: 180, frame() {} };</script>');
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, 'held'), '');
    chmodSync(work, 0o555);
    await assert.rejects(render([dir], { out: join(dir, 'out.mp4'), workers: 1, onProgress() {}, format: { video: ['-c:v', 'no_such_encoder'] } }), /^Error: ffmpeg: .*no_such_encoder/);
  } finally {
    chmodSync(work, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an encoder out of memory is said plainly, with fewer browsers to try', () => {
  const x264 = new Error('ffmpeg: x264 [error]: malloc of size 6220800 failed\nError while opening encoder');
  assert.match(outOfMemory(x264, 5).message, /^ffmpeg ran out of memory with 5 browsers rendering at once: try fewer, for example --workers 2\nffmpeg: x264/);
  assert.match(outOfMemory(new Error('ffmpeg: exit 3221225495'), 2).message, /--workers 1\n/, 'Windows ended it for lack of memory');
  assert.match(outOfMemory(x264, 1).message, /^ffmpeg ran out of memory: close other apps and try again\n/);
  const other = new Error('ffmpeg: Unknown encoder');
  assert.equal(outOfMemory(other, 5), other, 'any other error is told as it is');
});

test('browsers: one per performance core but one, as many as the free memory holds with room to spare, enough frames each, at most four', () => {
  const GB = 2 ** 30;
  assert.equal(defaultWorkers({ cores: 4, available: 6.5 * GB }), 3, 'an M5 with 16 GB, 41% free');
  assert.equal(defaultWorkers({ cores: 4, available: 3 * GB }), 1, 'little memory free: one, never swapping');
  assert.equal(defaultWorkers({ cores: 12, available: 48 * GB }), 4, 'a big machine: four, as one graphics chip takes no more');
  assert.equal(defaultWorkers({ cores: 2, available: 16 * GB }), 1, 'two cores: one left for the person');
  assert.equal(defaultWorkers({ cores: 8, available: 32 * GB }, 100), 1, 'a short render: one browser, its start not worth more');
  assert.equal(defaultWorkers({ cores: 8, available: 32 * GB }, 240), 4);
  const { cores, available } = machine();
  assert.ok(cores >= 1 && available > 0 && available <= totalmem(), `this machine: ${cores} cores, ${available} bytes free`);
});

test('a render runs below the person\'s own apps, with every process it starts', { skip: !hasFfmpeg && 'no ffmpeg', timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'of-render-priority-'));
  try {
    /* a project Studio has shown before (`.film/opened`), so the command goes straight to the render */
    writeFileSync(join(dir, 'p.html'), '<!doctype html><body><script>window.film = { duration: 3, width: 320, height: 180, frame() {} };</script>');
    writeFileSync(join(dir, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'p', src: 'p.html', at: 0, time: [0, 3] }] }] }));
    mkdirSync(join(dir, '.film'));
    writeFileSync(join(dir, '.film', 'opened'), '');
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/openfilm.mjs', import.meta.url)), 'render', '0-3', '--workers', '1', '--out', join(dir, 'out.mp4')], { cwd: dir, stdio: 'ignore' });
    const ended = new Promise((done) => child.on('exit', done));
    /* read until it is lowered: the process may start at another nice value (a CI runner's is not 0) */
    let priority = null;
    for (const end = Date.now() + 20_000; priority !== 10 && child.exitCode == null && Date.now() < end;) {
      try { priority = getPriority(/** @type {number} */ (child.pid)); } catch { break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    await ended;
    assert.equal(priority, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
