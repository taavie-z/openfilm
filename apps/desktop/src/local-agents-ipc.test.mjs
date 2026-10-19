import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLog } from './chat-store.mjs';
import { agentProblem, registerLocalAgentIpc, sentError } from './local-agents-ipc.mjs';

test("a start that fails is written in the log of the turn it was for, with why", async () => {
  const handlers = new Map();
  registerLocalAgentIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, { trusted: () => true });
  const project = mkdtempSync(join(tmpdir(), 'openfilm-ipc-'));
  const event = { sender: { once() {}, isDestroyed: () => false, send() {} } };
  /* the own key with no models set up: refused before anything starts */
  const r = await handlers.get('desktop:local-agents:start')(event, { agent: 'byok', cwd: project, meta: { turnId: 'local:startfail1' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not-ready');
  await new Promise((done) => setTimeout(done, 50));
  const start = readLog(project, 'local:startfail1')?.events.find((e) => e.kind === 'start');
  assert.ok(start, 'the turn has a log');
  assert.equal(start.ok, false);
  assert.equal(start.error, r.error);
  assert.equal(start.agent, 'byok');
  assert.equal(start.meta.turnId, 'local:startfail1');
});

test('an agent that failed, as its problem is kept: its name, why, the step, the last of its stderr and its turn\'s log', () => {
  const session = { stderr: 'a\nb\nc\nd\ne\nError: write EPIPE\n' };
  const e = Object.assign(new Error('ACP connection closed'), { code: -32603 });
  assert.deepEqual(agentProblem({ agent: 'codex', cwd: '/p/Film', session }, 'prompt', e, 'local:abc'), {
    area: 'agent', agent: 'Codex', agentId: 'codex', what: 'ACP connection closed', step: 'prompt', code: '-32603',
    project: '/p/Film', log: join('/p/Film', '.film', 'logs', 'local-abc.jsonl'), stderr: 'b\nc\nd\ne\nError: write EPIPE',
  });
  /* a session that says how it failed (agents.mjs `failure()`): its step, program and own logs */
  const told = { failure: () => ({ step: 'session/new', program: '/x/codex', stderr: '', ownLogs: '/h/.codex' }) };
  assert.deepEqual(agentProblem({ agent: 'codex', cwd: '/p/Film', session: told }, 'start', new Error('Internal error')), {
    area: 'agent', agent: 'Codex', agentId: 'codex', what: 'Internal error', step: 'session/new', project: '/p/Film', program: '/x/codex', ownLogs: '/h/.codex',
  });
  assert.equal(agentProblem({ agent: 'byok', cwd: '/p' }, 'start', 'no models').agent, 'Own key');
});

test('the error as the agent sent it, under any rewording on the way; none when it sent none', () => {
  const sent = Object.assign(new Error('Internal error'), { code: -32603, data: { details: 'stream closed' } });
  const reworded = new Error('Codex stopped while answering without saying why.', { cause: new Error('stream closed', { cause: sent }) });
  assert.deepEqual(sentError(reworded), { code: -32603, message: 'Internal error', data: { details: 'stream closed' } });
  assert.equal(sentError(new Error('not installed')), null);
});
