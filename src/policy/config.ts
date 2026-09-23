import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Severity } from '../findings.js';

export interface Config {
  /** Lowest severity that needs a human ack. Default `danger`. */
  approvalLevel: Severity;
  /** Treat every delete/replace as dangerous, not just stateful resources. */
  treatAllDeletesAsDanger: boolean;
  statefulTypes: { add: string[]; remove: string[] };
  /** Address globs to ignore (`module.scratch.*`, `DevStack/*`). */
  ignore: string[];
  /** Path the config was loaded from, if any. */
  source?: string;
}

export const DEFAULT_CONFIG: Config = {
  approvalLevel: 'danger',
  treatAllDeletesAsDanger: false,
  statefulTypes: { add: [], remove: [] },
  ignore: [],
};

export const CONFIG_FILE = '.plansentry.json';

export class ConfigError extends Error {}

export function findConfig(cwd: string): string | undefined {
  let d = cwd;
  for (let i = 0; i < 30; i++) {
    const p = join(d, CONFIG_FILE);
    if (existsSync(p)) return p;
    if (existsSync(join(d, '.git'))) return undefined; // don't escape the repo
    const parent = dirname(d);
    if (parent === d) return undefined;
    d = parent;
  }
  return undefined;
}

export function loadConfig(cwd: string): Config {
  const path = findConfig(cwd);
  if (!path) return structuredClone(DEFAULT_CONFIG);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError(`${path}: ${(e as Error).message}`);
  }
  return { ...parseConfig(raw, path), source: path };
}

export function parseConfig(raw: unknown, where = CONFIG_FILE): Config {
  const cfg = structuredClone(DEFAULT_CONFIG);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ConfigError(`${where}: expected an object`);
  const r = raw as Record<string, unknown>;
  const strings = (v: unknown, key: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new ConfigError(`${where}: ${key} must be an array of strings`);
    return v as string[];
  };
  if (r.approvalLevel !== undefined) {
    if (r.approvalLevel !== 'danger' && r.approvalLevel !== 'warn' && r.approvalLevel !== 'info') {
      throw new ConfigError(`${where}: approvalLevel must be "danger", "warn" or "info"`);
    }
    cfg.approvalLevel = r.approvalLevel;
  }
  if (r.treatAllDeletesAsDanger !== undefined) {
    if (typeof r.treatAllDeletesAsDanger !== 'boolean') throw new ConfigError(`${where}: treatAllDeletesAsDanger must be a boolean`);
    cfg.treatAllDeletesAsDanger = r.treatAllDeletesAsDanger;
  }
  if (r.statefulTypes !== undefined) {
    const s = r.statefulTypes as Record<string, unknown>;
    if (typeof s !== 'object' || s === null) throw new ConfigError(`${where}: statefulTypes must be an object`);
    cfg.statefulTypes = { add: strings(s.add, 'statefulTypes.add'), remove: strings(s.remove, 'statefulTypes.remove') };
  }
  cfg.ignore = strings(r.ignore, 'ignore');
  for (const k of Object.keys(r)) {
    if (!['$schema', 'approvalLevel', 'treatAllDeletesAsDanger', 'statefulTypes', 'ignore'].includes(k)) {
      throw new ConfigError(`${where}: unknown key "${k}"`);
    }
  }
  return cfg;
}
