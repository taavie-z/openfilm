import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exactRate, ffmpegRate } from './rate.mjs';

test('the NTSC rates are their exact rates; another rate is kept as it is', () => {
  for (const [fps, num] of [[23.976, 24000], [23.98, 24000], [29.97, 30000], [30000 / 1001, 30000], [47.952, 48000], [59.94, 60000], [119.88, 120000]]) {
    assert.deepEqual(exactRate(fps), { fps: num / 1001, num, den: 1001 }, `${fps}`);
    assert.equal(ffmpegRate(exactRate(fps)), `${num}/1001`);
  }
  for (const fps of [1, 12.5, 24, 25, 30, 60, 240]) assert.deepEqual(exactRate(fps), { fps, num: fps, den: 1 }, `${fps}`);
  assert.equal(ffmpegRate(exactRate(29.97), 8), '240000/1001');
  assert.equal(ffmpegRate(exactRate(12.5), 2), '25');
});
