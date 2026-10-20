/**
 * Where the person's own agents are (agents.mjs AGENTS: Claude Code, Codex, Qwen Code, …). Only real installations count: a config folder survives an
 * uninstall and is never evidence. On Windows an install by npm, pnpm or Yarn leaves a `.cmd` shim, which no program
 * can start without a shell: what it runs is used instead (cmdTarget), and one that cannot be read is started through
 * cmd.exe (agents.mjs). A program the person chose themselves (Settings → Agents → Locate) comes before any of these.
 * Reads no Electron module, so `node --test` can use it.
 */
import { execFileSync } from 'node:child_process';
import { accessSync, closeSync, constants, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

import { AGENT_DEFINITIONS, OWN_AGENT_IDS } from './agent-definitions.mjs';
export const AGENT_DOWNLOADS = Object.freeze(Object.fromEntries(OWN_AGENT_IDS.map((id) => [id, AGENT_DEFINITIONS[id].install])));

/**
 * Each agent's program, by the names it installs (the first found counts), and the folders its own installer puts it
 * in beside the usual ones (HOME_BIN_CANDIDATES): those are not always on the PATH an app gets.
 */
export const AGENT_PROGRAMS = Object.freeze({
  claude: { names: ['claude'] },
  codex: { names: ['codex'] },
  copilot: { names: ['copilot'] },
  /* Cursor's installer names it `agent`, and `cursor-agent` as before; either counts only in Cursor's own folder
     (notTheAgent), as other tools are called `agent` too. On Windows that folder is %LOCALAPPDATA%\cursor-agent */
  cursor: { names: ['cursor-agent', 'agent'], dirs: (home, win) => (win ? [join(localAppData(home), 'cursor-agent')] : []) },
  opencode: { names: ['opencode'], dirs: (home) => [join(home, '.opencode', 'bin')] },
  /* CodeBuddy's own installer keeps it in %LOCALAPPDATA%\codebuddy\bin on Windows */
  codebuddy: { names: ['codebuddy', 'cbc'], dirs: (home, win) => (win ? [join(localAppData(home), 'codebuddy', 'bin')] : []) },
  /* Qwen Code's own installer keeps it in %LOCALAPPDATA%\qwen-code\bin on Windows */
  qwen: { names: ['qwen'], dirs: (home, win) => (win ? [join(localAppData(home), 'qwen-code', 'bin')] : []) },
  /* Kimi Code's own installer keeps it in ~/.kimi-code/bin; kimi-cli (uv) puts it in ~/.local/bin */
  kimi: { names: ['kimi'], dirs: (home) => [join(home, '.kimi-code', 'bin')] },
  /* MiniMax Code's own installer keeps it in ~/.minimax-code/bin */
  minimax: { names: ['mcode'], dirs: (home) => [join(home, '.minimax-code', 'bin')] },
});

/** %LOCALAPPDATA% (Windows). */
const localAppData = (home) => process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');

/**
 * Whether a program is in Cursor's own folder (…/cursor-agent/…, or Homebrew's cursor-cli), followed through its link.
 */
export function inCursorFolder(file) {
  let real = file;
  try { real = realpathSync(file); } catch { /* as it is */ }
  return /[\\/](?:cursor-agent|Caskroom[\\/]cursor-cli)[\\/]/i.test(real);
}

/**
 * Where editors keep their own launchers, never an agent: VS Code, Cursor and the like keep their command (`code`,
 * `cursor`) in resources/app/bin (inside the .app on a Mac). The Windows .cmd there runs resources/app/out/cli.js,
 * which opens the editor with whatever it is given as files to open.
 */
const LAUNCHERS = [
  /[\\/]resources[\\/]app[\\/]bin[\\/]/i,
  /[\\/]app[\\/]out[\\/]cli\.js$/i,
  /[\\/]Programs[\\/]cursor[\\/]/i,
  /[\\/](?:Microsoft VS Code|Visual Studio Code)[^\\/]*[\\/]/i,
];

/**
 * Why a program found or chosen for an agent is not the agent, or null: `app`, an editor's or a desktop app's own
 * launcher (on Windows, a window program too); `not-cursor-agent`, one for Cursor outside Cursor's own folder.
 * `chosen`: what the person chose, when `file` is what it runs.
 * @returns {'app' | 'not-cursor-agent' | null}
 */
export function notTheAgent(id, file, { chosen = null, win = windows } = {}) {
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  const paths = [file, real(file), ...(chosen ? [chosen, real(chosen)] : [])];
  if (paths.some((p) => LAUNCHERS.some((re) => re.test(p)))) return 'app';
  if (win && /\.exe$/i.test(file) && exeSubsystem(real(file)) === WINDOW_SUBSYSTEM) return 'app';
  if (id === 'cursor' && !inCursorFolder(file)) return 'not-cursor-agent';
  return null;
}

export function executableFile(path) {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
}

/* a Windows program's subsystem: 3 is the console, 2 a window */
const CONSOLE_SUBSYSTEM = 3;
const WINDOW_SUBSYSTEM = 2;

/** A Windows program's subsystem, read from its header without starting it; null when it is not one or can't be read. */
function exeSubsystem(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(4096);
    const read = readSync(fd, head, 0, head.length, 0);
    if (read < 64 || head.toString('latin1', 0, 2) !== 'MZ') return null;
    const pe = head.readUInt32LE(0x3c);
    /* the subsystem sits at the same place in 32- and 64-bit headers */
    if (pe + 0x5e > read || head.toString('latin1', pe, pe + 4) !== 'PE\0\0') return null;
    return head.readUInt16LE(pe + 0x5c);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Whether a file is a Windows program for the console, by its header and without starting it: a window program (a
 * desktop app's own, as `app\Codex.exe` in the Codex Store app is) would open its window, and answers nothing.
 */
export function consoleProgram(path) {
  return exeSubsystem(path) === CONSOLE_SUBSYSTEM;
}

/**
 * Claude Code as the Claude app keeps it: one folder per version, newest first, the program either straight inside
 * (`<version>/claude.app`) or one folder down (`<version>/<build>/claude.app`, newer apps). On a Mac under
 * Application Support; on Windows `claude.exe` under %APPDATA%\Claude, or the same folder of the app from the
 * Microsoft Store (its own copy of %APPDATA% under Packages\Claude_…): the newest of them.
 */
export function claudeAppCli(home = homedir(), { win = windows } = {}) {
  const program = win ? 'claude.exe' : 'claude.app/Contents/MacOS/claude';
  const usable = win ? existsFile : executableFile;
  const inside = (dir) => {
    const direct = join(dir, program);
    if (usable(direct)) return direct;
    let builds = [];
    try { builds = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'claude.app').map((d) => d.name); } catch { return null; }
    return builds.map((b) => join(dir, b, program)).find(usable) ?? null;
  };
  const found = [];
  for (const root of claudeAppRoots(home, win)) {
    let versions = [];
    try { versions = readdirSync(root).filter((v) => /^\d+(\.\d+)*$/.test(v)); } catch { continue; /* the Claude app has not downloaded Claude Code */ }
    for (const version of versions) found.push({ version, root });
  }
  return found.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
    .map(({ version, root }) => inside(join(root, version))).find(Boolean) ?? null;
}

/** Where the Claude app keeps Claude Code's versions. */
function claudeAppRoots(home, win) {
  if (!win) return [join(home, 'Library/Application Support/Claude/claude-code')];
  const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  const packages = join(localAppData(home), 'Packages');
  let store = [];
  try { store = readdirSync(packages).filter((d) => /^Claude_/i.test(d)).map((d) => join(packages, d, 'LocalCache', 'Roaming', 'Claude', 'claude-code')); } catch { /* none */ }
  return [join(appData, 'Claude', 'claude-code'), ...store];
}

/**
 * Which Claude Code a program is, told from where it is installed without starting it: the Claude app's and Homebrew's
 * folders and the official installer's file are named for the version (`claude-code/2.1.295/…`,
 * `Caskroom/claude-code/2.1.295/…`, `claude/versions/2.1.295`); npm's has its package.json. Null when it can't be told.
 */
export function claudeVersion(file) {
  let real;
  try { real = realpathSync(file); } catch { return null; }
  /* npm's first: its folders can be named for Node's version (Homebrew's Cellar/node/26.0.0/lib/node_modules/…) */
  for (let dir = dirname(real), up = 0; up < 3; dir = dirname(dir), up += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg.name === '@anthropic-ai/claude-code' && typeof pkg.version === 'string') return pkg.version;
    } catch { /* not here */ }
  }
  return real.split(/[\\/]/).reverse().find((part) => /^\d+\.\d+\.\d+$/.test(part)) ?? null;
}

/** What programs said of their version (`--version`), by program and its time: each asked once. */
const versionsAsked = new Map();

/** What a program says its version is (`codex-cli 0.163.0`, `opencode v2.0.24`); null when it says nothing in two seconds. */
function askVersion(/** @type {string} */ file) {
  /* a `.cmd` shim cannot be started without a shell; npm's says its version in its package.json anyway */
  if (/\.(cmd|bat)$/i.test(file)) return null;
  try {
    const out = execFileSync(file, ['--version'], { encoding: 'utf8', timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Which version a program is: npm's says it in its package.json (`ours`: the package's names), a folder can be named
 * for it (Homebrew's `Caskroom/codex/0.163.0/…`), an app can keep it in a file beside it (`opencode-cli.version`);
 * else it says when asked (`--version`), once. Null when it can't be told.
 * @param {string} file @param {{ ours: (name: string) => boolean, ask: (file: string) => string | null }} o
 */
function programVersion(file, { ours, ask }) {
  let real;
  try { real = realpathSync(file); } catch { return null; }
  for (let dir = dirname(real), up = 0; up < 6; dir = dirname(dir), up += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (typeof pkg.name === 'string' && ours(pkg.name) && typeof pkg.version === 'string') return pkg.version.replace(/-.*$/, '');
    } catch { /* not here */ }
  }
  const named = real.split(/[\\/]/).reverse().find((part) => /^\d+\.\d+\.\d+$/.test(part));
  if (named) return named;
  try {
    const beside = readFileSync(`${real}.version`, 'utf8').trim();
    if (/^\d+\.\d+\.\d+$/.test(beside)) return beside;
  } catch { /* none */ }
  let key;
  try { key = `${real}\0${statSync(real).mtimeMs}`; } catch { return null; }
  if (!versionsAsked.has(key)) versionsAsked.set(key, ask(real));
  return versionsAsked.get(key) ?? null;
}

/**
 * Which Codex a program is: npm's says it in its package.json (`@openai/codex`, or the platform package its program
 * is in), Homebrew's folder is named for it (`Caskroom/codex/0.163.0/…`); a copy inside an app (Codex.app,
 * ChatGPT.app, a Store app) says it when asked (`--version`), once. Null when it can't be told.
 * @param {string} file @param {{ ask?: (file: string) => string | null }} [o]
 */
export function codexVersion(file, { ask = askVersion } = {}) {
  return programVersion(file, { ours: (name) => name.startsWith('@openai/codex'), ask });
}

/**
 * Which OpenCode a program is: npm's package (`opencode-ai`, or its platform package), Homebrew's folder, the file
 * OpenCode.app keeps beside its copy (`opencode-cli.version`), else what it says when asked.
 * @param {string} file @param {{ ask?: (file: string) => string | null }} [o]
 */
export function opencodeVersion(file, { ask = askVersion } = {}) {
  return programVersion(file, { ours: (name) => name === 'opencode-ai' || name.startsWith('opencode-'), ask });
}

/** Whether version `a` is later than `b` (dotted numbers); false when either is unknown. */
export function laterVersion(a, b) {
  if (!a || !b) return false;
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

const windows = process.platform === 'win32';
const valueOf = (env, name) => Object.entries(env ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] || undefined;

/**
 * The folders Windows installers put programs in, which an app's PATH does not always have: the agents' own
 * installers (~/.local/bin), npm, pnpm, Volta, nvm-windows, Yarn, Bun, Scoop, Chocolatey, winget, and the commands
 * of apps from the Microsoft Store.
 */
export function windowsBinDirs(env = process.env, home = homedir()) {
  const v = (name) => valueOf(env, name);
  const appData = v('APPDATA') ?? join(home, 'AppData', 'Roaming');
  const local = v('LOCALAPPDATA') ?? join(home, 'AppData', 'Local');
  return [
    join(home, '.local', 'bin'),
    join(appData, 'npm'),
    ...(v('PNPM_HOME') ? [v('PNPM_HOME')] : []), join(local, 'pnpm'),
    ...(v('VOLTA_HOME') ? [join(v('VOLTA_HOME'), 'bin')] : []), join(local, 'Volta', 'bin'),
    ...(v('NVM_SYMLINK') ? [v('NVM_SYMLINK')] : []),
    join(local, 'Yarn', 'bin'),
    join(home, '.bun', 'bin'),
    ...(v('SCOOP') ? [join(v('SCOOP'), 'shims')] : []), join(home, 'scoop', 'shims'),
    join(v('ProgramData') ?? join(home, '..', '..', 'ProgramData'), 'chocolatey', 'bin'),
    join(local, 'Microsoft', 'WinGet', 'Links'),
    join(local, 'Microsoft', 'WindowsApps'),
  ];
}

export const HOME_BIN_CANDIDATES = (home = homedir()) => (windows
  ? windowsBinDirs(process.env, home)
  : [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']);

/** What a program is called on Windows, in the order cmd.exe tries (an extensionless file there is a shell script). */
const WIN_SUFFIXES = ['.exe', '.cmd', '.bat'];
const isCmdScript = (path) => /\.(?:cmd|bat)$/i.test(path);

/**
 * A program file on Windows. A Microsoft Store app's command (WindowsApps) is a link that cannot be followed like a
 * file, yet starts like one: there, being there is enough.
 */
function presentFile(path) {
  try { return statSync(path).isFile(); } catch { /* maybe a Store app's command */ }
  try { const s = lstatSync(path); return s.isFile() || s.isSymbolicLink(); } catch { return false; }
}

/** each folder once (on Windows whatever its case), as first spelled */
function unique(dirs, win) {
  const seen = new Map();
  for (const d of dirs) if (d && isAbsolute(d) && !seen.has(win ? d.toLowerCase() : d)) seen.set(win ? d.toLowerCase() : d, d);
  return [...seen.values()];
}
/* an environment spread from Windows' own has its Path as well as the PATH set on purpose: that one wins */
const pathIn = (env) => env?.PATH ?? valueOf(env, 'PATH') ?? '';

export function findExecutable(name, extraDirs = [], env = process.env, { win = windows } = {}) {
  const path = pathIn(env);
  for (const dir of unique([...path.split(win ? ';' : delimiter), ...extraDirs], win)) {
    for (const suffix of win ? WIN_SUFFIXES : ['']) {
      const file = join(dir, name + suffix);
      if (win ? presentFile(file) : executableFile(file)) return win && isCmdScript(file) ? cmdTarget(file) ?? file : file;
    }
  }
  return null;
}

/* what a shim runs: "%dp0%\…" (npm), "%~dp0\…" (pnpm, Yarn); never the node.exe it may run it with */
const SHIM_TARGET = /"%(?:~dp0|_?dp0%)\\?([^"%]+?\.(?:js|cjs|mjs|exe|cmd|bat))"/gi;
const scriptFirst = (rel) => (/\.(?:c|m)?js$/i.test(rel) ? 0 : /\.exe$/i.test(rel) ? 1 : 2);

/**
 * What a `.cmd` shim runs (Windows): the package's script or program, which can be started without a shell (a `.cmd`
 * cannot be). Yarn's shim runs another shim, which is read in turn. Codex's script only starts its own program, so
 * the program itself, for this machine's chip; when there is none, not the script (the chat starts Codex as a shell
 * command, which a script is not): the shim it came from instead. Null when the shim says nothing that is there, or
 * runs a Node of the package's own.
 */
export function cmdTarget(cmd, depth = 0) {
  let text = '';
  try { text = readFileSync(cmd, 'utf8'); } catch { return null; }
  const named = [...new Set([...text.matchAll(SHIM_TARGET)].map((m) => m[1]))];
  /* a package that runs on a Node of its own (Cursor's agent: its native parts are built for it), not one npm may put
     beside the shim: the shim itself, which starts that Node */
  if (named.some((rel) => /[\\/]node\.exe$/i.test(rel))) return null;
  const rels = named
    .filter((rel) => !/(?:^|[\\/])node\.exe$/i.test(rel))
    .sort((a, b) => scriptFirst(a) - scriptFirst(b));
  for (const rel of rels) {
    const target = join(dirname(cmd), ...rel.split(/[\\/]+/));
    if (isCmdScript(target)) {
      const next = depth < 3 && existsFile(target) ? cmdTarget(target, depth + 1) : null;
      if (next) return next;
      continue;
    }
    if (/[\\/]@openai[\\/]codex[\\/]/i.test(target) && /\.js$/i.test(target)) {
      const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
      const pkg = target.replace(/[\\/]bin[\\/][^\\/]+$/, '');
      /* the platform package it installs beside its script, or one folder up when that was hoisted, and the one it
         ships itself: `bin`, as the package's own script says, `codex` in older ones */
      const exe = [
        join(pkg, 'node_modules', '@openai', `codex-win32-${process.arch}`, 'vendor', triple, 'bin', 'codex.exe'),
        join(pkg, '..', `codex-win32-${process.arch}`, 'vendor', triple, 'bin', 'codex.exe'),
        join(pkg, 'vendor', triple, 'bin', 'codex.exe'),
        join(pkg, 'vendor', triple, 'codex', 'codex.exe'),
        join(pkg, 'node_modules', '@openai', `codex-win32-${process.arch}`, 'vendor', triple, 'codex', 'codex.exe'),
      ].find(existsFile);
      if (exe) return exe;
      /* a shell command cannot start the script, so the shim it came from (null here) is used instead */
      continue;
    }
    if (existsFile(target)) return target;
  }
  return null;
}

function existsFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

/* where Codex is inside Codex.app and ChatGPT.app */
const CODEX_IN_APP = ['Contents/Resources/codex', 'Contents/Resources/codex-cli/bin/codex'];

/** The copies of Codex inside Codex.app and ChatGPT.app in these folders, Codex.app's first. */
function codexInApps(/** @type {string[]} */ applicationDirs) {
  return applicationDirs.flatMap((dir) => ['Codex.app', 'ChatGPT.app'].flatMap((app) => CODEX_IN_APP.map((p) => join(dir, app, p)))).filter(executableFile);
}

/* where OpenCode is inside OpenCode.app, its desktop app (macOS) */
const OPENCODE_IN_APP = 'Contents/Resources/opencode-cli';

/** The copies of OpenCode inside OpenCode.app in these folders. */
function opencodeInApps(/** @type {string[]} */ applicationDirs) {
  return applicationDirs.map((dir) => join(dir, 'OpenCode.app', OPENCODE_IN_APP)).filter(executableFile);
}

/**
 * The program the person chose for an agent, as it can be started: a `.cmd` shim's target, the `.cmd` beside a
 * PowerShell shim (`.ps1`), the program inside a folder or an app chosen instead of it. Null when it is not there.
 */
export function chosenProgram(path, { names = [], win = windows } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) return null;
  let folder = false;
  try { folder = statSync(path).isDirectory(); } catch { /* a file, or not there */ }
  if (folder) {
    const inApp = /\.app$/i.test(path) ? [...CODEX_IN_APP, OPENCODE_IN_APP, ...names.map((n) => `Contents/MacOS/${n}`)].map((p) => join(path, p)).find(executableFile) : null;
    return inApp ?? names.map((n) => findExecutable(n, [path, join(path, 'bin')], { PATH: '' }, { win })).find(Boolean) ?? null;
  }
  if (win) {
    if (/\.ps1$/i.test(path)) {
      const cmd = path.replace(/\.ps1$/i, '.cmd');
      return presentFile(cmd) ? cmdTarget(cmd) ?? cmd : null;
    }
    if (!presentFile(path)) return null;
    return isCmdScript(path) ? cmdTarget(path) ?? path : path;
  }
  return executableFile(path) || (/\.(?:c|m)?js$/i.test(path) && existsFile(path)) ? path : null;
}

/**
 * The command line program, or the copy inside the maker's own desktop app (many people only ever installed the
 * app): Codex ships inside Codex.app and ChatGPT.app, OpenCode inside OpenCode.app; the Claude app keeps Claude Code
 * in its own folder, one folder per version, the newest used. `chosen`: the program the person chose, first.
 * `others`: programs found some other way (a Store app's own copy, agents.mjs), after the rest. `source` says which it
 * is: chosen · path · app. An editor's or a desktop app's own launcher is never taken for the agent (notTheAgent).
 */
export function detectAgentInstallation(id, { home = homedir(), env = process.env, pathDirs = HOME_BIN_CANDIDATES(home),
  applicationDirs = ['/Applications', join(home, 'Applications')], chosen = null, others = [], win = windows, codexVersionOf = codexVersion,
  opencodeVersionOf = opencodeVersion } = {}) {
  const program = AGENT_PROGRAMS[id] ?? { names: [id] };
  const install = AGENT_DOWNLOADS[id] ?? null;
  const picked = chosen ? chosenProgram(chosen, { names: program.names, win }) : null;
  if (picked && !notTheAgent(id, picked, { chosen, win })) return { installed: true, cli: picked, source: 'chosen', install };
  const dirs = [...pathDirs, ...(program.dirs?.(home, win) ?? [])];
  let cli = null;
  for (const name of program.names) {
    if (cli) break;
    /* each folder in turn: a program by that name that is not the agent (an editor's launcher, another tool's
       `agent`) does not hide the agent's own in a later folder */
    for (const dir of unique([...pathIn(env).split(win ? ';' : delimiter), ...dirs], win)) {
      const file = findExecutable(name, [dir], { PATH: '' }, { win });
      if (file && !notTheAgent(id, file, { win })) { cli = file; break; }
    }
  }
  const usable = (file) => (win ? presentFile(file) : executableFile(file));
  /* copies kept up to date by the maker's app (Codex: or a Store app), and how their version is told */
  const copies = id === 'codex' ? [...codexInApps(applicationDirs), ...others.filter(usable)] : id === 'opencode' ? opencodeInApps(applicationDirs) : [];
  const versionOf = id === 'opencode' ? opencodeVersionOf : codexVersionOf;
  if (cli) {
    /* Claude Code both on the PATH (an npm install that is never updated, say) and in the Claude app, which keeps its
       own up to date: the later one, whose models are the current ones. One whose version can't be told stays. */
    const inApp = id === 'claude' ? claudeAppCli(home, { win }) : null;
    if (inApp && laterVersion(claudeVersion(inApp), claudeVersion(cli))) return { installed: true, cli: inApp, source: 'app', install };
    /* Codex and OpenCode the same: one installed long ago beside the copy in their app (Codex: or a Store app), which
       keeps its own up to date. Its models are the ones its version is offered, so the later one is used */
    const mine = copies.length ? versionOf(cli) : null;
    let newest = null;
    for (const copy of copies) {
      const version = versionOf(copy);
      if (laterVersion(version, newest?.version ?? mine)) newest = { copy, version };
    }
    if (newest) return { installed: true, cli: newest.copy, source: 'app', install };
    return { installed: true, cli, source: 'path', install };
  }
  cli = copies[0] ?? null;
  if (!cli && id === 'claude') cli = claudeAppCli(home, { win });
  if (!cli) cli = others.find(usable) ?? null;
  return { installed: Boolean(cli), cli, source: cli ? 'app' : null, install };
}

/**
 * The maker's desktop apps an agent's own program does not come with (an editor among them), by agent: their bundle on
 * a Mac, and on Windows their folder (under %LOCALAPPDATA%\Programs, most of them); `name` is what the person knows
 * them by. VS Code counts for GitHub Copilot only with its Copilot extension. Claude's: Claude Code comes once its
 * Code tab is opened.
 */
const DESKTOP_APPS = {
  claude: { name: 'Claude', mac: /^Claude\.app$/i, win: (local) => [join(local, 'AnthropicClaude'), ...folders(join(local, 'Packages'), /^Claude_/i)] },
  copilot: { name: 'VS Code', mac: /^Visual Studio Code.*\.app$/i, win: (local) => folders(join(local, 'Programs'), /^Microsoft VS Code/i),
    with: (home) => folders(join(home, '.vscode', 'extensions'), /^github\.copilot/i).length > 0 },
  cursor: { name: 'Cursor', mac: /^Cursor\.app$/i, win: (local) => folders(join(local, 'Programs'), /^cursor$/i) },
  codebuddy: { name: 'CodeBuddy', mac: /^CodeBuddy.*\.app$/i, win: (local) => folders(join(local, 'Programs'), /^CodeBuddy/i) },
  kimi: { name: 'Kimi', mac: /^Kimi.*\.app$/i, win: (local) => folders(join(local, 'Programs'), /^Kimi/i) },
  minimax: { name: 'MiniMax', mac: /^MiniMax.*\.app$/i, win: (local) => folders(join(local, 'Programs'), /^MiniMax/i) },
};

/** The folders in a folder whose names match. */
function folders(dir, re) {
  try { return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && re.test(d.name)).map((d) => join(dir, d.name)); } catch { return []; }
}

/**
 * The name of the maker's desktop app when it is installed (DESKTOP_APPS), or null: told from where it is, nothing
 * started. For an agent whose own program is not found: the app is here, its command-line agent is not.
 */
export function desktopApp(id, { home = homedir(), applicationDirs = ['/Applications', join(home, 'Applications')], win = windows } = {}) {
  const app = DESKTOP_APPS[id];
  if (!app) return null;
  const here = win
    ? app.win(localAppData(home)).some((dir) => { try { return statSync(dir).isDirectory(); } catch { return false; } })
    : applicationDirs.some((dir) => folders(dir, app.mac).length > 0);
  return here && (!app.with || app.with(home)) ? app.name : null;
}

/**
 * Each agent's official installer, as its maker's install page gives it, run in a terminal window the person sees
 * once they agree to it: `sh` on a Mac (and Linux), `ps` in PowerShell on Windows. The others are installed from their
 * install page (AGENT_DOWNLOADS).
 */
export const AGENT_INSTALLERS = Object.freeze({
  /* cursor.com/docs/cli/installation */
  cursor: { sh: 'curl https://cursor.com/install -fsS | bash', ps: "irm 'https://cursor.com/install?win32=true' | iex" },
  /* docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli */
  copilot: { sh: 'curl -fsSL https://gh.io/copilot-install | bash', ps: 'winget install GitHub.Copilot' },
  /* www.codebuddy.cn/docs/cli/installation */
  codebuddy: { sh: 'curl -fsSL https://www.codebuddy.cn/cli/install.sh | bash', ps: 'irm https://www.codebuddy.cn/cli/install.ps1 | iex' },
  /* github.com/QwenLM/qwen-code */
  qwen: {
    sh: 'curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash',
    ps: 'irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex',
  },
  /* www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html */
  kimi: { sh: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash', ps: 'irm https://code.kimi.com/kimi-code/install.ps1 | iex' },
  /* agent.minimax.io/docs/cli/quick-start */
  minimax: { sh: 'curl -fsSL https://filecdn.minimax.chat/public/install.sh | bash', ps: 'irm https://filecdn.minimax.chat/public/install.ps1 | iex' },
});

/** The command that installs an agent on this system (AGENT_INSTALLERS), or null when it has none. */
export function installCommand(id, { win = windows } = {}) {
  const installer = AGENT_INSTALLERS[id];
  return installer ? (win ? installer.ps : installer.sh) : null;
}

/**
 * For a person whose agent is not found, what was looked at: every folder searched, and each file there with one of
 * the agent's names (any suffix, a PowerShell shim too) with what it runs, if that can be told, and why it is not the
 * agent when it is not (`refused`, notTheAgent).
 */
export function searchReport(id, { home = homedir(), env = process.env, pathDirs = HOME_BIN_CANDIDATES(home), win = windows } = {}) {
  const program = AGENT_PROGRAMS[id] ?? { names: [id] };
  const searched = unique([...pathIn(env).split(win ? ';' : delimiter), ...pathDirs, ...(program.dirs?.(home, win) ?? [])], win);
  const files = [];
  for (const dir of searched) {
    for (const name of program.names) {
      for (const suffix of ['', '.exe', '.cmd', '.bat', '.ps1']) {
        const file = join(dir, name + suffix);
        if (!presentFile(file)) continue;
        const runs = isCmdScript(file) ? cmdTarget(file) : /\.ps1$/i.test(file) ? null : file;
        const refused = runs ? notTheAgent(id, runs, { chosen: file, win }) : null;
        files.push({ file, runs, usable: !refused && (win ? suffix !== '' && suffix !== '.ps1' : executableFile(file)), ...(refused ? { refused } : {}) });
      }
    }
  }
  return { searched, files };
}
