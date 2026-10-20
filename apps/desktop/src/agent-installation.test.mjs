import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_INSTALLERS, chosenProgram, claudeAppCli, codexAppCopies, claudeVersion, cmdTarget, codexVersion, consoleProgram, desktopApp, detectAgentInstallation, findExecutable, installCommand, laterVersion, notTheAgent, opencodeVersion, searchReport, windowsBinDirs } from './agent-installation.mjs';

test("an npm .cmd shim (Windows) runs its package's script: that is what gets started", () => {
  const npm = mkdtempSync(join(tmpdir(), 'of-npm-'));
  const script = join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  mkdirSync(join(script, '..'), { recursive: true });
  writeFileSync(script, '');
  writeFileSync(join(npm, 'claude.cmd'), '@ECHO off\r\nGOTO start\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
  assert.equal(cmdTarget(join(npm, 'claude.cmd')), script);
  writeFileSync(join(npm, 'other.cmd'), '@echo off\r\necho hi\r\n');
  assert.equal(cmdTarget(join(npm, 'other.cmd')), null);
});

test('Claude Code as the Claude app keeps it: straight in a version folder, or one build folder down; newest first', () => {
  const home = mkdtempSync(join(tmpdir(), 'of-home-'));
  const root = join(home, 'Library/Application Support/Claude/claude-code');
  assert.equal(claudeAppCli(home, { win: false }), null);
  const old = join(root, '2.1.9', 'claude.app/Contents/MacOS/claude');
  const recent = join(root, '2.1.10', 'f2326db61802', 'claude.app/Contents/MacOS/claude');
  for (const file of [old, recent]) { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, '', { mode: 0o755 }); }
  assert.equal(claudeAppCli(home, { win: false }), recent);
});

test("an agent is found by any of its names, and in its own installer's folder off the PATH (Kimi Code's ~/.kimi-code/bin)", () => {
  if (process.platform === 'win32') return;
  const home = mkdtempSync(join(tmpdir(), 'of-home-'));
  const none = { home, env: { PATH: '' }, pathDirs: [], applicationDirs: [] };
  assert.equal(detectAgentInstallation('kimi', none).cli, null);
  const kimi = join(home, '.kimi-code', 'bin', 'kimi');
  mkdirSync(join(kimi, '..'), { recursive: true });
  writeFileSync(kimi, '', { mode: 0o755 });
  assert.equal(detectAgentInstallation('kimi', none).cli, kimi);
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'cbc'), '', { mode: 0o755 });
  assert.equal(detectAgentInstallation('codebuddy', { ...none, pathDirs: [bin] }).cli, join(bin, 'cbc'));
});

/** a file, its folders made */
const put = (file, text = '', mode = 0o644) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text, { mode }); return file; };

/* the shim npm writes today: it names node.exe first, which is not what it runs */
const npmShim = (rel) => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*\r\n`;

test("npm's shim as it is written today: what it runs, never the node.exe it checks for first", () => {
  const npm = mkdtempSync(join(tmpdir(), 'of-npm-'));
  const script = put(join(npm, 'node_modules', '@qwen-code', 'qwen-code', 'cli.js'));
  put(join(npm, 'qwen.cmd'), npmShim('node_modules\\@qwen-code\\qwen-code\\cli.js'));
  assert.equal(cmdTarget(join(npm, 'qwen.cmd')), script);
});

test("Codex's npm shim: its own program for this machine's chip, not the script that starts it", () => {
  const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  /* where the package puts the program: in the platform package it installs, beside its script or hoisted one folder
     up (`bin`, as the package's own script says), or in itself (`bin`, and `codex` in older ones) */
  const layouts = [
    ['node_modules', '@openai', 'codex', 'node_modules', '@openai', `codex-win32-${process.arch}`, 'vendor', triple, 'bin', 'codex.exe'],
    ['node_modules', '@openai', `codex-win32-${process.arch}`, 'vendor', triple, 'bin', 'codex.exe'],
    ['node_modules', '@openai', 'codex', 'vendor', triple, 'bin', 'codex.exe'],
    ['node_modules', '@openai', 'codex', 'vendor', triple, 'codex', 'codex.exe'],
    ['node_modules', '@openai', 'codex', 'node_modules', '@openai', `codex-win32-${process.arch}`, 'vendor', triple, 'codex', 'codex.exe'],
  ];
  for (const layout of layouts) {
    const npm = mkdtempSync(join(tmpdir(), 'of-npm-'));
    put(join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
    const exe = put(join(npm, ...layout));
    put(join(npm, 'codex.cmd'), npmShim('node_modules\\@openai\\codex\\bin\\codex.js'));
    assert.equal(cmdTarget(join(npm, 'codex.cmd')), exe, layout.join('/'));
  }
});

test("Codex's shim with no program of its own: the shim itself, never its script, which a shell command cannot start", () => {
  const npm = mkdtempSync(join(tmpdir(), 'of-npm-'));
  put(join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
  put(join(npm, 'codex.cmd'), npmShim('node_modules\\@openai\\codex\\bin\\codex.js'));
  assert.equal(cmdTarget(join(npm, 'codex.cmd')), null);
  assert.equal(findExecutable('codex', [], { PATH: npm }, { win: true }), join(npm, 'codex.cmd'));
});

test("pnpm's shim (%~dp0, node.exe beside it or not) and Yarn's, which runs another shim", () => {
  const pnpm = mkdtempSync(join(tmpdir(), 'of-pnpm-'));
  const script = put(join(pnpm, 'global', '5', 'node_modules', '@qwen-code', 'qwen-code', 'cli.js'));
  put(join(pnpm, 'qwen.CMD'), '@SETLOCAL\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\global\\5\\node_modules\\@qwen-code\\qwen-code\\cli.js" %*\r\n) ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\global\\5\\node_modules\\@qwen-code\\qwen-code\\cli.js" %*\r\n)\r\n');
  assert.equal(cmdTarget(join(pnpm, 'qwen.CMD')), script);

  const local = mkdtempSync(join(tmpdir(), 'of-yarn-'));
  const yarnScript = put(join(local, 'Data', 'global', 'node_modules', 'opencode-ai', 'bin', 'opencode.js'));
  put(join(local, 'Data', 'global', 'node_modules', '.bin', 'opencode.cmd'), npmShim('..\\opencode-ai\\bin\\opencode.js'));
  put(join(local, 'bin', 'opencode.cmd'), '@"%~dp0\\..\\Data\\global\\node_modules\\.bin\\opencode.cmd" %*\r\n');
  assert.equal(cmdTarget(join(local, 'bin', 'opencode.cmd')), yarnScript);
});

test('on Windows a program is a .exe, .cmd or .bat (never the extensionless script beside it), the PATH given first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'of-win-'));
  put(join(dir, 'kimi'), '#!/bin/sh');
  assert.equal(findExecutable('kimi', [], { PATH: dir }, { win: true }), null);
  const exe = put(join(dir, 'kimi.exe'));
  /* an environment spread from Windows' own has its Path too: the PATH set on purpose wins */
  assert.equal(findExecutable('kimi', [], { Path: '', PATH: dir }, { win: true }), exe);
  const other = mkdtempSync(join(tmpdir(), 'of-win-'));
  const bat = put(join(other, 'copilot.bat'), '@echo off\r\n');
  assert.equal(findExecutable('copilot', [other], { PATH: '' }, { win: true }), bat, 'a shim that says nothing is kept as it is: cmd.exe starts it');
});

test("the folders Windows installers use, the person's own variables first", () => {
  const home = join(tmpdir(), 'Users', 'ana');
  const env = { APPDATA: join(home, 'Roaming'), LOCALAPPDATA: join(home, 'Local'), pnpm_home: join(home, 'pn'), NVM_SYMLINK: join(home, 'nodejs'), ProgramData: join(tmpdir(), 'PD') };
  const dirs = windowsBinDirs(env, home);
  for (const dir of [join(home, '.local', 'bin'), join(home, 'Roaming', 'npm'), join(home, 'pn'), join(home, 'Local', 'pnpm'), join(home, 'Local', 'Volta', 'bin'),
    join(home, 'nodejs'), join(home, 'scoop', 'shims'), join(tmpdir(), 'PD', 'chocolatey', 'bin'), join(home, 'Local', 'Microsoft', 'WinGet', 'Links'), join(home, 'Local', 'Microsoft', 'WindowsApps')]) {
    assert.ok(dirs.includes(dir), dir);
  }
});

test('the program the person chose comes first; it can be a shim, the .cmd beside a .ps1, or a folder with it inside', () => {
  const home = mkdtempSync(join(tmpdir(), 'of-home-'));
  const bin = join(home, 'bin');
  const onPath = put(join(bin, 'codex'), '', 0o755);
  const mine = put(join(home, 'mine', 'codex'), '', 0o755);
  const opts = { home, env: { PATH: bin }, pathDirs: [], applicationDirs: [] };
  if (process.platform !== 'win32') {
    assert.deepEqual(detectAgentInstallation('codex', opts), { installed: true, cli: onPath, source: 'path', install: 'https://developers.openai.com/codex' });
    assert.equal(detectAgentInstallation('codex', { ...opts, chosen: mine }).source, 'chosen');
    assert.equal(detectAgentInstallation('codex', { ...opts, chosen: mine }).cli, mine);
    assert.equal(detectAgentInstallation('codex', { ...opts, chosen: join(home, 'gone') }).cli, onPath, 'one chosen and gone: found as before');
    assert.equal(chosenProgram(join(home, 'mine'), { names: ['codex'] }), mine, 'a folder: the program in it');
    const app = put(join(home, 'Codex.app', 'Contents', 'Resources', 'codex'), '', 0o755);
    assert.equal(chosenProgram(join(home, 'Codex.app'), { names: ['codex'] }), app, 'an app: the Codex inside it');
    assert.equal(chosenProgram(put(join(home, 'notes.txt')), { names: ['codex'] }), null, 'not a program');
  }
  const npm = join(home, 'npm');
  const script = put(join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'));
  put(join(npm, 'claude.cmd'), npmShim('node_modules\\@anthropic-ai\\claude-code\\cli.js'));
  put(join(npm, 'claude.ps1'), '#!/usr/bin/env pwsh');
  assert.equal(chosenProgram(join(npm, 'claude.ps1'), { names: ['claude'], win: true }), script);
  assert.equal(chosenProgram(join(npm, 'claude.cmd'), { names: ['claude'], win: true }), script);
  assert.equal(chosenProgram('relative\\claude.exe', { names: ['claude'], win: true }), null);
});

/** A Windows program's header, enough to tell its subsystem: 3 the console, 2 a window. */
function peProgram(subsystem, { wide = true } = {}) {
  const bytes = Buffer.alloc(0x200);
  bytes.write('MZ', 0, 'latin1');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'latin1');
  bytes.writeUInt16LE(wide ? 0x20b : 0x10b, 0x80 + 24);
  bytes.writeUInt16LE(subsystem, 0x80 + 0x5c);
  return bytes;
}

test('a console program is told from a window program by its header, without starting it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'of-pe-'));
  const at = (name, bytes) => { const file = join(dir, name); writeFileSync(file, bytes); return file; };
  assert.equal(consoleProgram(at('codex.exe', peProgram(3))), true);
  assert.equal(consoleProgram(at('codex32.exe', peProgram(3, { wide: false }))), true);
  /* the Codex Store app's own Codex.exe: its window, not the CLI */
  assert.equal(consoleProgram(at('Codex.exe', peProgram(2))), false);
  /* the Linux CLI the same app carries for WSL, a script, a cut-off file, nothing */
  assert.equal(consoleProgram(at('codex', Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60)]))), false);
  assert.equal(consoleProgram(at('codex.cmd', '@echo off')), false);
  assert.equal(consoleProgram(at('short.exe', peProgram(3).subarray(0, 0x90))), false);
  assert.equal(consoleProgram(join(dir, 'missing.exe')), false);
});

test('a program found some other way (a Store app) is used last', () => {
  if (process.platform === 'win32') return;
  const home = mkdtempSync(join(tmpdir(), 'of-home-'));
  const store = put(join(home, 'Store', 'OpenAI.Codex', 'codex.exe'), '', 0o755);
  const opts = { home, env: { PATH: '' }, pathDirs: [], applicationDirs: [] };
  assert.equal(detectAgentInstallation('codex', opts).cli, null);
  assert.deepEqual(detectAgentInstallation('codex', { ...opts, others: [store] }), { installed: true, cli: store, source: 'app', install: 'https://developers.openai.com/codex' });
});

test('the report: every folder searched, each file with the name, what a shim runs, and what cannot be started', () => {
  const home = mkdtempSync(join(tmpdir(), 'of-home-'));
  const npm = join(home, 'npm');
  const script = put(join(npm, 'node_modules', '@qwen-code', 'qwen-code', 'cli.js'));
  put(join(npm, 'qwen'), '#!/bin/sh');
  put(join(npm, 'qwen.cmd'), npmShim('node_modules\\@qwen-code\\qwen-code\\cli.js'));
  put(join(npm, 'qwen.ps1'), '');
  const report = searchReport('qwen', { home, env: { PATH: `${npm};${npm.toUpperCase()}` }, pathDirs: [join(home, 'other')], win: true });
  const own = join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'qwen-code', 'bin');
  assert.deepEqual(report.searched, [npm, join(home, 'other'), own], 'each folder once, whatever its case, its own installer\'s last');
  assert.deepEqual(report.files, [
    { file: join(npm, 'qwen'), runs: join(npm, 'qwen'), usable: false },
    { file: join(npm, 'qwen.cmd'), runs: script, usable: true },
    { file: join(npm, 'qwen.ps1'), runs: null, usable: false },
  ]);
});

test('Claude Code on the PATH and in the Claude app: the later one is used, told from where each is installed', () => {
  if (process.platform === 'win32') return;
  const home = mkdtempSync(join(tmpdir(), 'of-home-'));
  const exe = (file) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, '', { mode: 0o755 }); return file; };
  const inApp = exe(join(home, 'Library/Application Support/Claude/claude-code/2.1.295/abc/claude.app/Contents/MacOS/claude'));
  assert.equal(claudeVersion(inApp), '2.1.295');

  /* an npm install never updated, under a Node whose folder is named for its own version */
  const npm = join(home, 'Cellar/node/26.0.0/lib/node_modules/@anthropic-ai/claude-code');
  const cliJs = exe(join(npm, 'cli.js'));
  writeFileSync(join(npm, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.280' }));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  symlinkSync(cliJs, join(bin, 'claude'));
  assert.equal(claudeVersion(join(bin, 'claude')), '2.1.280', "npm's own version, not Node's");
  const found = detectAgentInstallation('claude', { home, env: { PATH: '' }, pathDirs: [bin] });
  assert.deepEqual([found.cli, found.source], [inApp, 'app']);

  /* the official installer's, later than the app's: the one on the PATH */
  const native = exe(join(home, '.local/share/claude/versions/2.1.300'));
  const local = join(home, 'local-bin');
  mkdirSync(local);
  symlinkSync(native, join(local, 'claude'));
  assert.equal(detectAgentInstallation('claude', { home, env: { PATH: '' }, pathDirs: [local] }).cli, join(local, 'claude'));

  /* one whose version can't be told stays as it is found */
  const plain = join(home, 'plain-bin');
  exe(join(plain, 'claude'));
  assert.equal(claudeVersion(join(plain, 'claude')), null);
  assert.equal(detectAgentInstallation('claude', { home, env: { PATH: '' }, pathDirs: [plain] }).source, 'path');
  assert.equal(laterVersion('2.1.10', '2.1.9'), true);
  assert.equal(laterVersion('2.1.9', '2.1.9'), false);
});

test('which Codex a program is: npm\'s package, Homebrew\'s folder, else what it says when asked, once', () => {
  const home = mkdtempSync(join(tmpdir(), 'of-home-'));
  const pkg = join(home, 'npm', 'node_modules', '@openai', 'codex');
  put(join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.42.0' }));
  const script = put(join(pkg, 'bin', 'codex.js'));
  assert.equal(codexVersion(script), '0.42.0');
  /* its program in the platform package npm puts beside it */
  const plat = join(home, 'npm', 'node_modules', '@openai', 'codex-win32-x64');
  put(join(plat, 'package.json'), JSON.stringify({ name: '@openai/codex-win32-x64', version: '0.150.0-win32-x64' }));
  assert.equal(codexVersion(put(join(plat, 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'))), '0.150.0');
  assert.equal(codexVersion(put(join(home, 'Caskroom', 'codex', '0.163.0', 'codex-aarch64-apple-darwin'))), '0.163.0');
  let asked = 0;
  const inApp = put(join(home, 'Codex.app', 'Contents', 'Resources', 'codex'));
  const ask = () => { asked += 1; return '0.170.1'; };
  assert.equal(codexVersion(inApp, { ask }), '0.170.1');
  assert.equal(codexVersion(inApp, { ask }), '0.170.1');
  assert.equal(asked, 1, 'asked once while the program is the same');
  assert.equal(codexVersion(join(home, 'gone')), null);
});

test('Codex installed long ago beside the copy an app keeps up to date: the later one is used', () => {
  if (process.platform === 'win32') return;
  const home = mkdtempSync(join(tmpdir(), 'of-home-'));
  const bin = join(home, 'bin');
  const onPath = put(join(bin, 'codex'), '', 0o755);
  const apps = join(home, 'Applications');
  const inApp = put(join(apps, 'ChatGPT.app', 'Contents', 'Resources', 'codex'), '', 0o755);
  const store = put(join(home, 'Store', 'codex.exe'), '', 0o755);
  const versions = (map) => (file) => map[file] ?? null;
  const opts = { home, env: { PATH: bin }, pathDirs: [], applicationDirs: [apps] };
  assert.deepEqual(detectAgentInstallation('codex', { ...opts, codexVersionOf: versions({ [onPath]: '0.42.0', [inApp]: '0.163.0' }) }),
    { installed: true, cli: inApp, source: 'app', install: 'https://developers.openai.com/codex' });
  assert.equal(detectAgentInstallation('codex', { ...opts, others: [store], codexVersionOf: versions({ [onPath]: '0.42.0', [inApp]: '0.163.0', [store]: '0.170.0' }) }).cli, store, 'the latest of them');
  assert.equal(detectAgentInstallation('codex', { ...opts, codexVersionOf: versions({ [onPath]: '0.170.0', [inApp]: '0.163.0' }) }).cli, onPath, 'the one on the PATH is the later');
  assert.equal(detectAgentInstallation('codex', { ...opts, codexVersionOf: versions({ [inApp]: '0.163.0' }) }).cli, onPath, 'one whose version can\'t be told stays');
  assert.equal(detectAgentInstallation('codex', { ...opts, chosen: onPath, codexVersionOf: versions({ [onPath]: '0.1.0', [inApp]: '0.163.0' }) }).cli, onPath, 'the one chosen, whatever its version');
});

test("Cursor installed as `agent` alone is found; another program called `agent` is not taken for it", () => {
  if (process.platform === 'win32') return;
  const home = mkdtempSync(join(tmpdir(), 'of-home-'));
  const exe = (file) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, '', { mode: 0o755 }); return file; };
  /* some other tool's `agent` */
  const other = join(home, 'other-bin');
  exe(join(other, 'agent'));
  assert.equal(detectAgentInstallation('cursor', { home, env: { PATH: '' }, pathDirs: [other] }).cli, null);
  /* Cursor's installer: its own folder, linked as `agent` (the legacy `cursor-agent` link gone) */
  const real = exe(join(home, '.local/share/cursor-agent/versions/2026.10.16-e3cb207/cursor-agent'));
  const bin = join(home, '.local/bin');
  mkdirSync(bin, { recursive: true });
  symlinkSync(real, join(bin, 'agent'));
  assert.equal(detectAgentInstallation('cursor', { home, env: { PATH: '' }, pathDirs: [other, bin] }).cli, join(bin, 'agent'));
  /* both links, as the installer makes them now: `cursor-agent` first */
  symlinkSync(real, join(bin, 'cursor-agent'));
  assert.equal(detectAgentInstallation('cursor', { home, env: { PATH: '' }, pathDirs: [bin] }).cli, join(bin, 'cursor-agent'));
});

/* the .cmd an editor keeps in resources\app\bin (Windows): it runs the editor with Node, its arguments files to open */
const editorShim = (exe) => `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0..\\..\\..\\${exe}" "%~dp0..\\out\\cli.js" %*\r\nendlocal\r\n`;

test("an editor's own launcher is never taken for an agent: a .cmd running its out/cli.js, or anything in its resources/app/bin", () => {
  const home = mkdtempSync(join(tmpdir(), 'of-home-'));
  /* the Cursor editor on Windows, its launcher picked or found as Cursor's agent */
  const root = join(home, 'AppData', 'Local', 'Programs', 'cursor');
  const cli = put(join(root, 'resources', 'app', 'out', 'cli.js'));
  const bin = join(root, 'resources', 'app', 'bin');
  const cursorCmd = put(join(bin, 'cursor.cmd'), editorShim('Cursor.exe'));
  assert.equal(chosenProgram(cursorCmd, { names: ['cursor-agent', 'agent'], win: true }), cli, 'what the shim runs: the editor');
  assert.equal(notTheAgent('cursor', cli, { chosen: cursorCmd, win: true }), 'app');
  assert.equal(detectAgentInstallation('cursor', { home, env: { PATH: '' }, pathDirs: [], applicationDirs: [], chosen: cursorCmd, win: true }).cli, null,
    'a launcher chosen before is not used');
  /* one named like the agent in an editor's bin folder is not it either */
  put(join(bin, 'agent.cmd'), editorShim('Cursor.exe'));
  assert.equal(detectAgentInstallation('cursor', { home, env: { PATH: bin }, pathDirs: [], applicationDirs: [], win: true }).cli, null);
  /* VS Code's own `code` launcher on Windows, under Microsoft VS Code */
  const code = put(join(home, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'bin', 'copilot.cmd'), '@echo off\r\n');
  assert.equal(notTheAgent('copilot', code, { win: true }), 'app');
  /* a program of the agent's own is never refused */
  const npm = join(home, 'npm');
  const script = put(join(npm, 'node_modules', '@github', 'copilot', 'npm-loader.js'));
  put(join(npm, 'copilot.cmd'), npmShim('node_modules\\@github\\copilot\\npm-loader.js'));
  assert.equal(notTheAgent('copilot', script, { chosen: join(npm, 'copilot.cmd'), win: true }), null);
});

test("on a Mac an editor's launcher in its app, or linked from a bin folder, is skipped for the agent's own further on", () => {
  if (process.platform === 'win32') return;
  const home = mkdtempSync(join(tmpdir(), 'of-home-'));
  const inApp = put(join(home, 'Applications', 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'copilot'), '', 0o755);
  const linked = join(home, 'linked');
  mkdirSync(linked);
  symlinkSync(inApp, join(linked, 'copilot'));
  const mine = put(join(home, '.local', 'bin', 'copilot'), '', 0o755);
  const opts = { home, env: { PATH: [join(inApp, '..'), linked].join(':') }, pathDirs: [join(home, '.local', 'bin')], applicationDirs: [] };
  assert.equal(notTheAgent('copilot', join(linked, 'copilot')), 'app', 'followed through its link');
  assert.equal(detectAgentInstallation('copilot', opts).cli, mine);
  assert.equal(detectAgentInstallation('copilot', { ...opts, chosen: join(linked, 'copilot') }).cli, mine, 'chosen, and refused');
});

test('on Windows a window program (a desktop app) is never an agent; one whose header cannot be read still is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'of-pe-'));
  const app = join(dir, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'kimi.exe'), peProgram(2));
  assert.equal(notTheAgent('kimi', join(app, 'kimi.exe'), { win: true }), 'app');
  const home = mkdtempSync(join(tmpdir(), 'of-home-'));
  assert.equal(detectAgentInstallation('kimi', { home, env: { PATH: app }, pathDirs: [], applicationDirs: [], win: true }).cli, null);
  const cli = join(dir, 'cli');
  mkdirSync(cli);
  writeFileSync(join(cli, 'kimi.exe'), peProgram(3));
  assert.equal(detectAgentInstallation('kimi', { home, env: { PATH: `${app};${cli}` }, pathDirs: [], applicationDirs: [], win: true }).cli, join(cli, 'kimi.exe'));
  /* a Store app's command cannot be read as a file: it is not refused for that */
  writeFileSync(join(dir, 'codex.exe'), '');
  assert.equal(notTheAgent('codex', join(dir, 'codex.exe'), { win: true }), null);
});

test("Cursor's agent counts only in its own folder (or Homebrew's cursor-cli), whatever it is called", () => {
  if (process.platform === 'win32') return;
  const home = mkdtempSync(join(tmpdir(), 'of-home-'));
  const stray = put(join(home, 'bin', 'cursor-agent'), '', 0o755);
  assert.equal(notTheAgent('cursor', stray), 'not-cursor-agent');
  assert.equal(detectAgentInstallation('cursor', { home, env: { PATH: '' }, pathDirs: [join(home, 'bin')], applicationDirs: [] }).cli, null);
  const brew = put(join(home, 'Caskroom', 'cursor-cli', '2026.10.16-e3cb207', 'dist-package', 'cursor-agent'), '', 0o755);
  const links = join(home, 'brew-bin');
  mkdirSync(links);
  symlinkSync(brew, join(links, 'cursor-agent'));
  assert.equal(detectAgentInstallation('cursor', { home, env: { PATH: '' }, pathDirs: [join(home, 'bin'), links], applicationDirs: [] }).cli, join(links, 'cursor-agent'));
});

test("Cursor's agent on Windows: found in %LOCALAPPDATA%\\cursor-agent, started by its own shim, which runs its own Node", () => {
  if (process.platform === 'win32') return;
  const home = mkdtempSync(join(tmpdir(), 'of-home-'));
  const root = join(home, 'AppData', 'Local', 'cursor-agent');
  put(join(root, 'versions', '2026.10.16-e3cb207', 'index.js'));
  put(join(root, 'versions', '2026.10.16-e3cb207', 'node.exe'));
  const shim = put(join(root, 'agent.cmd'), '@echo off\r\n"%~dp0versions\\2026.10.16-e3cb207\\node.exe" "%~dp0versions\\2026.10.16-e3cb207\\index.js" %*\r\n');
  assert.equal(cmdTarget(shim), null, 'never its script with another Node');
  assert.equal(detectAgentInstallation('cursor', { home, env: { PATH: '' }, pathDirs: [], applicationDirs: [], win: true }).cli, shim);
});

test('Claude Code in the Claude app on Windows: under %APPDATA%\\Claude, or the Store app\'s own copy of it; the newest', () => {
  if (process.platform === 'win32') return;
  const home = mkdtempSync(join(tmpdir(), 'of-home-'));
  assert.equal(claudeAppCli(home, { win: true }), null);
  const roaming = put(join(home, 'AppData', 'Roaming', 'Claude', 'claude-code', '2.1.290', 'claude.exe'));
  assert.equal(claudeAppCli(home, { win: true }), roaming);
  const store = put(join(home, 'AppData', 'Local', 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude-code', '2.1.300', 'b1', 'claude.exe'));
  assert.equal(claudeAppCli(home, { win: true }), store);
  assert.equal(claudeVersion(store), '2.1.300');
  assert.deepEqual(detectAgentInstallation('claude', { home, env: { PATH: '' }, pathDirs: [], applicationDirs: [], win: true }).cli, store);
});

test("OpenCode inside OpenCode.app: used when it is the only one, or the later than the one on the PATH", () => {
  if (process.platform === 'win32') return;
  const home = mkdtempSync(join(tmpdir(), 'of-home-'));
  const apps = join(home, 'Applications');
  const inApp = put(join(apps, 'OpenCode.app', 'Contents', 'Resources', 'opencode-cli'), '', 0o755);
  writeFileSync(`${inApp}.version`, '2.0.24\n');
  assert.equal(opencodeVersion(inApp, { ask: () => assert.fail('read from the file beside it') }), '2.0.24');
  const opts = { home, env: { PATH: '' }, pathDirs: [], applicationDirs: [apps] };
  assert.deepEqual(detectAgentInstallation('opencode', opts), { installed: true, cli: inApp, source: 'app', install: 'https://opencode.ai/download' });
  const bin = join(home, 'bin');
  const onPath = put(join(bin, 'opencode'), '', 0o755);
  const versions = (map) => (file) => map[file] ?? null;
  assert.equal(detectAgentInstallation('opencode', { ...opts, pathDirs: [bin], opencodeVersionOf: versions({ [onPath]: '1.0.0', [inApp]: '2.0.24' }) }).cli, inApp);
  assert.equal(detectAgentInstallation('opencode', { ...opts, pathDirs: [bin], opencodeVersionOf: versions({ [onPath]: '2.1.0', [inApp]: '2.0.24' }) }).cli, onPath);
  assert.equal(chosenProgram(join(apps, 'OpenCode.app'), { names: ['opencode'] }), inApp, 'the app chosen: the OpenCode inside it');
  /* npm's says it in its package.json */
  const pkg = join(home, 'npm', 'node_modules', 'opencode-ai');
  put(join(pkg, 'package.json'), JSON.stringify({ name: 'opencode-ai', version: '1.4.2' }));
  assert.equal(opencodeVersion(put(join(pkg, 'bin', 'opencode'))), '1.4.2');
});

test("the maker's desktop app is told without its agent: by its bundle on a Mac, its folder on Windows; VS Code with Copilot only", () => {
  const home = mkdtempSync(join(tmpdir(), 'of-home-'));
  const apps = join(home, 'Applications');
  const mac = { home, applicationDirs: [apps], win: false };
  assert.equal(desktopApp('cursor', mac), null);
  mkdirSync(join(apps, 'Cursor.app'), { recursive: true });
  mkdirSync(join(apps, 'CodeBuddy CN.app'));
  mkdirSync(join(apps, 'Visual Studio Code.app'));
  assert.equal(desktopApp('cursor', mac), 'Cursor');
  assert.equal(desktopApp('codebuddy', mac), 'CodeBuddy');
  assert.equal(desktopApp('kimi', mac), null);
  assert.equal(desktopApp('copilot', mac), null, 'VS Code without the Copilot extension');
  mkdirSync(join(home, '.vscode', 'extensions', 'github.copilot-chat-0.30.0'), { recursive: true });
  assert.equal(desktopApp('copilot', mac), 'VS Code');
  assert.equal(desktopApp('qwen', mac), null, 'no desktop app');
  if (process.platform === 'win32') return;
  const win = { home, applicationDirs: [], win: true };
  assert.equal(desktopApp('minimax', win), null);
  mkdirSync(join(home, 'AppData', 'Local', 'Programs', 'MiniMax Agent'), { recursive: true });
  assert.equal(desktopApp('minimax', win), 'MiniMax');
  mkdirSync(join(home, 'AppData', 'Local', 'AnthropicClaude'), { recursive: true });
  assert.equal(desktopApp('claude', win), 'Claude');
});

test("each official installer: the maker's command for this system, the others none", () => {
  assert.equal(installCommand('cursor', { win: false }), 'curl https://cursor.com/install -fsS | bash');
  assert.equal(installCommand('cursor', { win: true }), "irm 'https://cursor.com/install?win32=true' | iex");
  assert.equal(installCommand('copilot', { win: true }), 'winget install GitHub.Copilot');
  for (const id of ['codex', 'claude', 'opencode', 'byok']) assert.equal(installCommand(id, { win: false }), null, id);
  for (const [id, { sh, ps }] of Object.entries(AGENT_INSTALLERS)) {
    assert.match(sh, /^curl .*https:\/\/\S+.*\| bash$/, id);
    assert.match(ps, /^(?:irm '?https:\/\/\S+'? \| iex|winget install \S+)$/, id);
  }
});

test('the report says which file is not the agent, and why', () => {
  const home = mkdtempSync(join(tmpdir(), 'of-home-'));
  const bin = join(home, 'Programs', 'cursor', 'resources', 'app', 'bin');
  put(join(home, 'Programs', 'cursor', 'resources', 'app', 'out', 'cli.js'));
  put(join(bin, 'agent.cmd'), editorShim('Cursor.exe'));
  const report = searchReport('cursor', { home, env: { PATH: bin }, pathDirs: [], win: true });
  assert.equal(report.files.length, 1);
  assert.equal(report.files[0].refused, 'app');
  assert.equal(report.files[0].usable, false);
});

test("Codex on Windows: never the copy in the Store app's own folder, which Windows won't start; the copy the Codex app starts", () => {
  if (process.platform === 'win32') return;
  const home = mkdtempSync(join(tmpdir(), 'of-home-'));
  const store = put(join(home, 'Program Files', 'WindowsApps', 'OpenAI.Codex_26.1002.7124.0_x64__2p2nqsd0c76g0', 'app', 'resources', 'codex.exe'));
  assert.equal(notTheAgent('codex', store, { win: true }), 'app');
  assert.equal(notTheAgent('codex', store, { chosen: store, win: true }), 'app');
  /* a Store app's command is not in its folder, and starts */
  assert.equal(notTheAgent('codex', join(home, 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'codex.exe'), { win: true }), null);
  const none = { home, env: { PATH: '' }, pathDirs: [], applicationDirs: [], win: true, codexVersionOf: () => null };
  assert.equal(detectAgentInstallation('codex', { ...none, others: [store] }).cli, null);
  const bin = join(home, 'AppData', 'Local', 'OpenAI', 'Codex', 'bin');
  const old = put(join(bin, '5d35d2790d1d3d7b', 'codex.exe'));
  const recent = put(join(bin, '247581e40ee272fb', 'codex.exe'));
  utimesSync(old, new Date(2026, 9, 1), new Date(2026, 9, 1));
  assert.deepEqual(codexAppCopies(home), [recent, old]);
  assert.deepEqual(detectAgentInstallation('codex', { ...none, others: [store] }), { installed: true, cli: recent, source: 'app', install: detectAgentInstallation('codex', none).install });
});
