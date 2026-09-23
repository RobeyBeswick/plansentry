import { LEADING_KEYWORDS, type SimpleCommand } from './parse.js';
import type { WordToken } from './tokenize.js';

export interface NormalizedCommand {
  /** Variable assignments that apply to the program (leading `A=b` and `env A=b`). */
  env: Record<string, string>;
  /** Wrapper words to keep when re-executing (e.g. `sudo`, `timeout 60`, `npx`). */
  prefix: string[];
  /** Program and arguments. Empty if the command is only assignments/keywords. */
  argv: string[];
  argvTokens: WordToken[];
  /** True if the program name itself is not statically known ($VAR, $(...)). */
  dynamicProgram: boolean;
  /** Offset where `plansentry exec --` can be inserted in the original string. */
  insertAt: number;
  /** Set when a wrapper hides the real command in a way we can't unpack. */
  opaqueReason?: string;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

type Consumer = (words: WordToken[], i: number, out: NormalizedCommand) => number | undefined;

/** Skip option words; `withArg` lists short/long options that take a separate argument. */
function skipOptions(words: WordToken[], i: number, withArg: Set<string>): number {
  while (i < words.length) {
    const w = words[i]!.value;
    if (w === '--') return i + 1;
    if (!w.startsWith('-') || w === '-') return i;
    i += withArg.has(w) ? 2 : 1;
  }
  return i;
}

const simple = (withArg: string[] = []): Consumer => {
  const set = new Set(withArg);
  return (words, i) => skipOptions(words, i + 1, set);
};

/** Runners of the form `tool sub [opts] [--] cmd...` (aws-vault exec, doppler run, ...). */
const runner = (sub: string[], positionals = 0, withArg: string[] = []): Consumer => {
  const set = new Set(withArg);
  return (words, i) => {
    let j = i + 1;
    for (const s of sub) {
      if (words[j]?.value !== s) return undefined;
      j++;
    }
    const dd = words.findIndex((w, k) => k >= j && w.value === '--');
    if (dd !== -1) return dd + 1;
    j = skipOptions(words, j, set);
    return j + positionals;
  };
};

const WRAPPERS: Record<string, Consumer> = {
  sudo: simple(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group']),
  doas: simple(['-u', '-C']),
  nohup: simple(),
  setsid: simple(),
  chronic: simple(),
  unbuffer: simple(),
  caffeinate: simple(['-t', '-w']),
  time: simple(['-f', '-o']),
  nice: simple(['-n', '--adjustment']),
  ionice: simple(['-c', '-n', '-p']),
  stdbuf: simple(['-i', '-o', '-e']),
  exec: simple(['-a']),
  builtin: simple(),
  command: (words, i, out) => {
    const j = skipOptions(words, i + 1, new Set());
    // `command -v terraform` only looks the program up.
    const opts = words.slice(i + 1, j).map((w) => w.value);
    if (opts.includes('-v') || opts.includes('-V')) {
      out.argv = [];
      return words.length;
    }
    return j;
  },
  timeout: (words, i) => {
    const j = skipOptions(words, i + 1, new Set(['-s', '-k', '--signal', '--kill-after']));
    return j + 1; // duration
  },
  watch: simple(['-n', '-d', '--interval']),
  xargs: simple(['-n', '-I', '-i', '-L', '-l', '-P', '-d', '-E', '-e', '-s', '-a', '--max-args', '--delimiter']),
  env: (words, i, out) => {
    let j = i + 1;
    while (j < words.length) {
      const w = words[j]!.value;
      if (w === '--') {
        j++;
        continue;
      }
      if (w === '-S' || w.startsWith('--split-string')) {
        out.opaqueReason = '`env -S` splits a string into a command';
        return words.length;
      }
      if (w === '-u' || w === '-C' || w === '--unset' || w === '--chdir') {
        j += 2;
        continue;
      }
      if (w.startsWith('-')) {
        j++;
        continue;
      }
      if (ASSIGNMENT.test(w)) {
        const eq = w.indexOf('=');
        out.env[w.slice(0, eq)] = w.slice(eq + 1);
        j++;
        continue;
      }
      break;
    }
    return j;
  },
  'aws-vault': runner(['exec'], 1, ['--region', '--duration', '-d', '--mfa-token', '-t']),
  'saml2aws': runner(['exec'], 0, ['--exec-profile', '-a', '--idp-account']),
  doppler: runner(['run'], 0, ['-p', '-c', '--project', '--config', '--command']),
  op: runner(['run'], 0, ['--env-file']),
  infisical: runner(['run'], 0, ['--env', '--path']),
  chamber: runner(['exec'], 0),
  dotenv: runner([], 0, ['-e', '-c', '-v']),
  'direnv': runner(['exec'], 1),
  mise: (words, i) => {
    const sub = words[i + 1]?.value;
    if (sub !== 'exec' && sub !== 'x') return undefined;
    const dd = words.findIndex((w, k) => k > i && w.value === '--');
    // Without `--`, mise treats the first arg as the command.
    return dd !== -1 ? dd + 1 : skipOptions(words, i + 2, new Set(['-C', '--cd', '-j', '--jobs']));
  },
  asdf: runner(['exec'], 0),
  // JS package runners: `npx cdk deploy`, `pnpm exec cdk`, `bunx cdk`, ...
  npx: (words, i, out) => jsRunner(words, i + 1, out),
  pnpx: (words, i, out) => jsRunner(words, i + 1, out),
  bunx: (words, i, out) => jsRunner(words, i + 1, out),
  npm: (words, i, out) => {
    const sub = words[i + 1]?.value;
    return sub === 'exec' || sub === 'x' ? jsRunner(words, i + 2, out) : undefined;
  },
  pnpm: (words, i, out) => {
    const sub = words[i + 1]?.value;
    return sub === 'exec' || sub === 'dlx' ? jsRunner(words, i + 2, out) : undefined;
  },
  yarn: (words, i, out) => {
    const sub = words[i + 1]?.value;
    return sub === 'exec' || sub === 'dlx' ? jsRunner(words, i + 2, out) : undefined;
  },
  bun: (words, i, out) => (words[i + 1]?.value === 'x' ? jsRunner(words, i + 2, out) : undefined),
};

function jsRunner(words: WordToken[], j: number, out: NormalizedCommand): number {
  while (j < words.length) {
    const w = words[j]!.value;
    if (w === '--') return j + 1;
    if (w === '-c' || w === '--call') {
      out.opaqueReason = `\`${words[0]?.value ?? 'npx'} -c\` runs a command string`;
      return words.length;
    }
    if (w === '-p' || w === '--package') {
      j += 2;
      continue;
    }
    if (w.startsWith('-')) {
      j++;
      continue;
    }
    return j;
  }
  return j;
}

export function basename(p: string): string {
  const s = p.replace(/\/+$/, '');
  const idx = s.lastIndexOf('/');
  return idx === -1 ? s : s.slice(idx + 1);
}

/** Program name without directory or a package-runner version suffix (`aws-cdk@2` → `aws-cdk`). */
export function programName(p: string): string {
  return basename(p).replace(/(?<=.)@[^@]*$/, '');
}

export function normalize(cmd: SimpleCommand): NormalizedCommand {
  const words = cmd.words;
  const out: NormalizedCommand = {
    env: {},
    prefix: [],
    argv: [],
    argvTokens: [],
    dynamicProgram: false,
    insertAt: cmd.start,
  };

  let i = 0;
  // Leading keywords and assignments.
  while (i < words.length) {
    const w = words[i]!;
    if (LEADING_KEYWORDS.has(w.value)) {
      i++;
      continue;
    }
    if (ASSIGNMENT.test(w.value)) {
      const eq = w.value.indexOf('=');
      out.env[w.value.slice(0, eq)] = w.value.slice(eq + 1);
      i++;
      continue;
    }
    break;
  }
  out.insertAt = words[i]?.start ?? cmd.end;

  // Wrappers, possibly nested (`sudo env X=1 timeout 60 npx cdk ...`).
  for (let guard = 0; guard < 16 && i < words.length; guard++) {
    const name = basename(words[i]!.value);
    const consumer = WRAPPERS[name];
    if (!consumer || words[i]!.dynamic) break;
    const next = consumer(words, i, out);
    if (next === undefined) break;
    out.prefix.push(...words.slice(i, next).map((w) => w.value));
    i = next;
    if (out.opaqueReason) return out;
  }

  const rest = words.slice(i);
  if (out.argv.length === 0 && rest.length) {
    out.argvTokens = rest;
    out.argv = rest.map((w) => w.value);
    out.dynamicProgram = rest[0]!.dynamic;
  }
  return out;
}
