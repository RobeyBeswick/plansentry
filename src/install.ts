import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type InstallTarget = 'claude' | 'codex';

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
  statusMessage?: string;
}
interface MatcherGroup {
  matcher?: string;
  hooks?: HookEntry[];
}
interface SettingsFile {
  hooks?: Record<string, MatcherGroup[]>;
  [k: string]: unknown;
}

export function settingsPath(target: InstallTarget, project: boolean, cwd = process.cwd()): string {
  const base = project ? cwd : homedir();
  return target === 'claude' ? join(base, '.claude', 'settings.json') : join(base, '.codex', 'hooks.json');
}

function hookCommand(target: InstallTarget): string {
  return `plansentry hook --agent ${target}`;
}

const isOurs = (h: HookEntry) => /^plansentry hook\b/.test(h.command ?? '');

/** Pure: returns the new settings object and whether anything changed. */
export function addHook(settings: SettingsFile, target: InstallTarget): { settings: SettingsFile; changed: boolean } {
  const next: SettingsFile = structuredClone(settings);
  next.hooks ??= {};
  const groups = (next.hooks.PreToolUse ??= []);
  if (groups.some((g) => g.hooks?.some(isOurs))) return { settings: next, changed: false };
  const entry: HookEntry = { type: 'command', command: hookCommand(target), timeout: 30 };
  if (target === 'codex') entry.statusMessage = 'plansentry: checking infrastructure commands';
  groups.push({ matcher: 'Bash', hooks: [entry] });
  return { settings: next, changed: true };
}

export function removeHook(settings: SettingsFile): { settings: SettingsFile; changed: boolean } {
  const next: SettingsFile = structuredClone(settings);
  const groups = next.hooks?.PreToolUse;
  if (!groups) return { settings: next, changed: false };
  let changed = false;
  const kept: MatcherGroup[] = [];
  for (const g of groups) {
    const hooks = (g.hooks ?? []).filter((h) => {
      const ours = isOurs(h);
      if (ours) changed = true;
      return !ours;
    });
    if (hooks.length) kept.push({ ...g, hooks });
    else if (!g.hooks?.some(isOurs)) kept.push(g);
  }
  next.hooks!.PreToolUse = kept;
  if (!kept.length) delete next.hooks!.PreToolUse;
  return { settings: next, changed };
}

function readSettings(path: string): SettingsFile {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) return {};
  return JSON.parse(text) as SettingsFile;
}

function writeWithBackup(path: string, settings: SettingsFile): string | undefined {
  mkdirSync(dirname(path), { recursive: true });
  let backup: string | undefined;
  if (existsSync(path)) {
    backup = `${path}.plansentry-backup`;
    copyFileSync(path, backup);
  }
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return backup;
}

export function installMain(args: string[], uninstall = false): number {
  const target = args.find((a) => !a.startsWith('-')) as InstallTarget | undefined;
  const project = args.includes('--project');
  if (target !== 'claude' && target !== 'codex') {
    process.stderr.write(`usage: plansentry ${uninstall ? 'uninstall' : 'install'} <claude|codex> [--project]\n`);
    return 2;
  }
  const path = settingsPath(target, project);
  let current: SettingsFile;
  try {
    current = readSettings(path);
  } catch (e) {
    process.stderr.write(`plansentry: ${path} is not valid JSON (${(e as Error).message}); not touching it.\n`);
    return 1;
  }
  const { settings, changed } = uninstall ? removeHook(current) : addHook(current, target);
  if (!changed) {
    process.stdout.write(uninstall ? `plansentry hook not present in ${path}\n` : `plansentry hook already installed in ${path}\n`);
    return 0;
  }
  const backup = writeWithBackup(path, settings);
  process.stdout.write(`${uninstall ? 'Removed' : 'Installed'} plansentry PreToolUse hook in ${path}\n`);
  if (backup) process.stdout.write(`Previous file saved as ${backup}\n`);
  if (!uninstall && target === 'codex') process.stdout.write('Codex requires you to trust new hooks: run /hooks in Codex and approve it.\n');
  if (!uninstall && target === 'claude') process.stdout.write('Restart Claude Code (or run /hooks) to pick it up.\n');
  return 0;
}
