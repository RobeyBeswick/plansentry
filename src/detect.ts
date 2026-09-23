import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { classifyCdk, parseCdk, type CdkInvocation, type CdkOperation } from './cdk/args.js';
import { parseCommands, type SimpleCommand } from './shell/parse.js';
import { basename, normalize, programName } from './shell/normalize.js';
import { ShellSyntaxError } from './shell/tokenize.js';
import {
  classifyTerraform,
  parseTerraform,
  terraformFlavor,
  type TerraformInvocation,
  type TerraformOperation,
} from './terraform/args.js';

interface Base {
  /** Chain of indirections, outermost first (e.g. ["make deploy", "bash -c"]). Empty = typed directly. */
  via: string[];
  cwd: string;
}

export interface TerraformOp extends Base {
  kind: 'terraform';
  op: TerraformOperation;
  inv: TerraformInvocation;
  env: Record<string, string>;
  prefix: string[];
  insertAt: number;
}

export interface CdkOp extends Base {
  kind: 'cdk';
  op: CdkOperation;
  inv: CdkInvocation;
  env: Record<string, string>;
  prefix: string[];
  insertAt: number;
}

/** Commands we don't analyse but that can destroy things; they need a human. */
export interface RiskyOp extends Base {
  kind: 'risky';
  description: string;
}

export interface PlansentryOp extends Base {
  kind: 'plansentry';
  argv: string[];
  ack?: string;
}

/** IaC activity we can see but not reliably unpack ($VAR programs, eval of variables, non-shell scripts). */
export interface OpaqueOp extends Base {
  kind: 'opaque';
  reason: string;
  snippet: string;
}

export type Operation = TerraformOp | CdkOp | RiskyOp | PlansentryOp | OpaqueOp;

export interface DetectOptions {
  cwd: string;
  /** Environment the command will inherit (for TF_CLI_ARGS and friends). */
  env?: Record<string, string | undefined>;
}

const MAX_DEPTH = 5;
const MAX_FILE_BYTES = 512 * 1024;

const GUARDED_TEXT = [
  /\b(terraform|tofu|terragrunt)\b[^\n;|&]*\b(apply|destroy)\b/,
  /\bcdk\b[^\n;|&]*\b(deploy|destroy|watch)\b/,
  /\bplansentry\b[^\n]*--ack\b/,
  /\bcloudformation\b[^\n;|&]*\bdelete-stack\b/,
];
const MENTIONS_IAC = /\b(terraform|tofu|terragrunt|cdk|cloudformation|plansentry)\b/;
const MENTIONS_ACTION = /\b(apply|destroy|deploy|delete-stack)\b/;

export function textLooksGuarded(text: string): boolean {
  return GUARDED_TEXT.some((re) => re.test(text));
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish']);
const INTERPRETERS = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'deno', 'tsx', 'ts-node', 'pwsh', 'powershell']);
const JS_PMS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
// Subcommands that are not script names for `yarn <x>` / `pnpm <x>` shorthand.
const PM_BUILTINS = new Set([
  'install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'ci', 'init', 'create',
  'publish', 'pack', 'link', 'unlink', 'list', 'ls', 'outdated', 'audit', 'why', 'info', 'view', 'config',
  'cache', 'login', 'logout', 'whoami', 'version', 'help', 'dedupe', 'prune', 'store', 'import', 'patch',
  'exec', 'dlx', 'x', 'set', 'workspaces', 'workspace', 'install-test', 'rebuild', 'root', 'bin',
]);

export function detect(command: string, opts: DetectOptions): Operation[] {
  const ops: Operation[] = [];
  walk(command, opts.cwd, [], 0, opts.env ?? {}, ops, true);
  return ops;
}

function walk(
  text: string,
  cwd: string,
  via: string[],
  depth: number,
  baseEnv: Record<string, string | undefined>,
  ops: Operation[],
  _topLevel: boolean,
): void {
  if (depth > MAX_DEPTH) {
    if (MENTIONS_IAC.test(text)) ops.push({ kind: 'opaque', reason: 'nesting too deep to analyse', snippet: clip(text), via, cwd });
    return;
  }
  let commands: SimpleCommand[];
  try {
    commands = parseCommands(text);
  } catch (e) {
    if (e instanceof ShellSyntaxError && MENTIONS_IAC.test(text)) {
      ops.push({ kind: 'opaque', reason: `could not parse shell syntax (${e.message})`, snippet: clip(text), via, cwd });
    }
    return;
  }

  let dir = cwd;
  for (let idx = 0; idx < commands.length; idx++) {
    const cmd = commands[idx]!;
    const cmdText = text.slice(cmd.start, cmd.end);
    const nestedVia = via;

    for (const w of cmd.words) {
      for (const sub of w.substitutions) {
        walk(sub, dir, [...via, 'command substitution'], depth + 1, baseEnv, ops, false);
      }
    }

    const n = normalize(cmd);
    if (n.opaqueReason) {
      if (MENTIONS_IAC.test(cmdText)) ops.push({ kind: 'opaque', reason: n.opaqueReason, snippet: clip(cmdText), via, cwd: dir });
      continue;
    }
    if (!n.argv.length) continue;

    const env = { ...stringEnv(baseEnv), ...n.env };
    const program = programName(n.argv[0]!);

    if (n.dynamicProgram) {
      if (MENTIONS_IAC.test(cmdText) || MENTIONS_ACTION.test(cmdText)) {
        ops.push({ kind: 'opaque', reason: 'the program name comes from a variable or command substitution', snippet: clip(cmdText), via, cwd: dir });
      }
      continue;
    }

    // Track directory changes for later commands in the same string.
    if (program === 'cd' || program === 'pushd') {
      const target = n.argv[1];
      if (target && !n.argvTokens[1]?.dynamic && target !== '-') dir = resolve(dir, expandHome(target));
      continue;
    }

    const flavor = terraformFlavor(program);
    if (flavor) {
      const inv = parseTerraform(n.argv, env, flavor);
      const op = classifyTerraform(inv);
      if (op.kind === 'state-mutation') {
        ops.push({ kind: 'risky', description: op.description, via: nestedVia, cwd: dir });
      } else if (op.kind !== 'safe') {
        ops.push({ kind: 'terraform', op, inv, env: n.env, prefix: n.prefix, insertAt: n.insertAt, via: nestedVia, cwd: dir });
      }
      continue;
    }

    if (program === 'terragrunt') {
      const rest = n.argv.slice(1).join(' ');
      if (/\b(apply|destroy)\b/.test(rest)) {
        ops.push({ kind: 'risky', description: `terragrunt ${rest} (terragrunt plans are not analysed yet)`, via: nestedVia, cwd: dir });
      }
      continue;
    }

    if (program === 'cdk' || program === 'aws-cdk') {
      const inv = parseCdk(n.argv);
      const op = classifyCdk(inv);
      if (op.kind === 'risky') ops.push({ kind: 'risky', description: op.description, via: nestedVia, cwd: dir });
      else if (op.kind !== 'safe') {
        ops.push({ kind: 'cdk', op, inv, env: n.env, prefix: n.prefix, insertAt: n.insertAt, via: nestedVia, cwd: dir });
      }
      continue;
    }

    if (program === 'aws' && n.argv[1] === 'cloudformation') {
      const sub = n.argv[2];
      if (sub === 'delete-stack') ops.push({ kind: 'risky', description: 'aws cloudformation delete-stack', via: nestedVia, cwd: dir });
      continue;
    }
    if (program === 'sam' && n.argv[1] === 'delete') {
      ops.push({ kind: 'risky', description: 'sam delete (deletes the whole stack)', via: nestedVia, cwd: dir });
      continue;
    }

    if (program === 'plansentry') {
      const ackIdx = n.argv.findIndex((a) => a === '--ack' || a.startsWith('--ack='));
      let ack: string | undefined;
      if (ackIdx !== -1) {
        const a = n.argv[ackIdx]!;
        ack = a.includes('=') ? a.slice(a.indexOf('=') + 1) : n.argv[ackIdx + 1];
      }
      ops.push({ kind: 'plansentry', argv: n.argv, ack, via: nestedVia, cwd: dir });
      continue;
    }

    if (program === 'eval') {
      const args = n.argvTokens.slice(1);
      const joined = args.map((w) => w.value).join(' ');
      if (args.some((w) => w.dynamic)) {
        if (MENTIONS_IAC.test(cmdText) || MENTIONS_ACTION.test(cmdText)) {
          ops.push({ kind: 'opaque', reason: '`eval` of a dynamic string', snippet: clip(cmdText), via, cwd: dir });
        }
      } else {
        walk(joined, dir, [...via, 'eval'], depth + 1, env, ops, false);
      }
      continue;
    }

    if (SHELLS.has(program)) {
      handleShell(n.argv, n.argvTokens.map((t) => t.dynamic), cmd, cmdText, text, dir, via, depth, env, ops);
      continue;
    }

    if (program === 'source' || program === '.') {
      const file = n.argv[1];
      if (file) scanFile(resolve(dir, expandHome(file)), dir, [...via, `source ${file}`], depth, env, ops, true);
      continue;
    }

    if (INTERPRETERS.has(program)) {
      handleInterpreter(n.argv, cmdText, dir, via, depth, env, ops);
      continue;
    }

    if (program === 'make' || program === 'gmake') {
      handleMake(n.argv, dir, via, depth, env, ops);
      continue;
    }
    if (program === 'just') {
      handleJust(n.argv, dir, via, depth, env, ops);
      continue;
    }
    if (program === 'task') {
      const file = ['Taskfile.yml', 'Taskfile.yaml', 'taskfile.yml'].map((f) => join(dir, f)).find((f) => existsSync(f));
      if (file) scanText(readSmall(file) ?? '', `task ${n.argv.slice(1).join(' ')}`.trim(), dir, via, ops);
      continue;
    }

    if (JS_PMS.has(program)) {
      handlePackageScript(n.argv, dir, via, depth, env, ops);
      continue;
    }

    // Executing a file by path: ./deploy.sh, scripts/apply, /tmp/x
    if (n.argv[0]!.includes('/')) {
      scanFile(resolve(dir, expandHome(n.argv[0]!)), dir, [...via, n.argv[0]!], depth, env, ops, false);
      continue;
    }
  }
}

function handleShell(
  argv: string[],
  dynamic: boolean[],
  cmd: SimpleCommand,
  cmdText: string,
  fullText: string,
  dir: string,
  via: string[],
  depth: number,
  env: Record<string, string>,
  ops: Operation[],
): void {
  const program = basename(argv[0]!);
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-c' || /^-[a-z]*c[a-z]*$/.test(a)) {
      const script = argv[i + 1];
      if (script === undefined) return;
      if (dynamic[i + 1]) {
        if (MENTIONS_IAC.test(cmdText) || MENTIONS_ACTION.test(cmdText)) {
          ops.push({ kind: 'opaque', reason: `\`${program} -c\` with a dynamic string`, snippet: clip(cmdText), via, cwd: dir });
        }
        return;
      }
      walk(script, dir, [...via, `${program} -c`], depth + 1, env, ops, false);
      return;
    }
    if (a.startsWith('-') || a.startsWith('+')) continue;
    scanFile(resolve(dir, expandHome(a)), dir, [...via, `${program} ${a}`], depth, env, ops, true);
    return;
  }
  // No script argument: commands come from a heredoc/here-string or a pipe.
  const heredoc = cmd.redirects.find((r) => r.heredoc !== undefined)?.heredoc;
  if (heredoc !== undefined) {
    walk(heredoc, dir, [...via, `${program} <<heredoc`], depth + 1, env, ops, false);
    return;
  }
  // Only our business if the pipeline mentions IaC (a heredoc feeding `cat | bash`, `echo terraform ... | sh`).
  if ((cmd.precededBy === '|' || cmd.precededBy === '|&') && MENTIONS_IAC.test(fullText)) {
    ops.push({ kind: 'opaque', reason: `commands piped into \`${program}\``, snippet: clip(cmdText), via, cwd: dir });
  }
}

function handleInterpreter(
  argv: string[],
  cmdText: string,
  dir: string,
  via: string[],
  depth: number,
  env: Record<string, string>,
  ops: Operation[],
): void {
  const program = basename(argv[0]!);
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-c' || a === '-e' || a === '--eval' || a === '-p' || a === '--print' || a === '-Command' || a === '-command') {
      const code = argv[i + 1] ?? '';
      scanText(code, `${program} ${a}`, dir, via, ops);
      return;
    }
    if (a === '-m') return; // module execution; not resolvable here
    if (a.startsWith('-')) continue;
    scanFile(resolve(dir, expandHome(a)), dir, [...via, `${program} ${a}`], depth, env, ops, false);
    return;
  }
  void cmdText;
}

/** Scan a script file. Shell scripts are parsed; anything else is scanned as text. */
function scanFile(
  path: string,
  dir: string,
  via: string[],
  depth: number,
  env: Record<string, string>,
  ops: Operation[],
  assumeShell: boolean,
): void {
  const content = readSmall(path);
  if (content === undefined) return;
  const firstLine = content.split('\n', 1)[0] ?? '';
  const isShell =
    /\.(sh|bash|zsh|ksh)$/.test(path) ||
    /^#!.*\b(ba|z|k|da)?sh\b/.test(firstLine) ||
    (assumeShell && !/^#!/.test(firstLine));
  if (isShell) walk(content, dir, via, depth + 1, env, ops, false);
  else scanText(content, via[via.length - 1] ?? path, dir, via.slice(0, -1), ops);
}

/** For non-shell code (python -c, node scripts, Taskfiles) we can only look for guarded commands in text. */
function scanText(text: string, label: string, dir: string, via: string[], ops: Operation[]): void {
  for (const line of text.split('\n')) {
    if (textLooksGuarded(line)) {
      ops.push({
        kind: 'opaque',
        reason: `\`${label}\` runs an infrastructure command plansentry cannot intercept`,
        snippet: clip(line.trim()),
        via: [...via, label],
        cwd: dir,
      });
      return;
    }
  }
}

function handleMake(argv: string[], dir: string, via: string[], depth: number, env: Record<string, string>, ops: Operation[]): void {
  let makeDir = dir;
  let file: string | undefined;
  const targets: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-C' || a === '--directory') makeDir = resolve(dir, argv[++i] ?? '.');
    else if (a.startsWith('-C') && a.length > 2) makeDir = resolve(dir, a.slice(2));
    else if (a === '-f' || a === '--file' || a === '--makefile') file = argv[++i];
    else if (a.startsWith('-') || a.includes('=')) continue;
    else targets.push(a);
  }
  const path = file
    ? resolve(makeDir, file)
    : ['GNUmakefile', 'makefile', 'Makefile'].map((f) => join(makeDir, f)).find((f) => existsSync(f));
  if (!path) return;
  const content = readSmall(path);
  if (content === undefined) return;
  const rules = parseMakefile(content);
  const wanted = targets.length ? targets : rules.defaultTarget ? [rules.defaultTarget] : [];
  const seen = new Set<string>();
  const visit = (t: string, chain: string[]) => {
    if (seen.has(t) || chain.length > 8) return;
    seen.add(t);
    const rule = rules.rules.get(t);
    if (!rule) return;
    for (const p of rule.prereqs) visit(p, [...chain, p]);
    const label = `make ${chain[0]}` + (chain.length > 1 ? ` → ${chain.slice(1).join(' → ')}` : '');
    for (const line of rule.recipe) {
      const cleaned = line.replace(/^[@+-]+/, '').replace(/\$\(MAKE\)|\$\{MAKE\}/g, 'make');
      // Expand make variables we can resolve (`TF = terraform`); anything else becomes a shell variable,
      // so `$(TF) apply` with an unknown TF is still treated as a dynamic program.
      const shellText = expandMakeVars(cleaned, rules.vars, env);
      walk(shellText, makeDir, [...via, label], depth + 1, env, ops, false);
    }
  };
  for (const t of wanted) visit(t, [t]);
}

const MAKE_VAR_REF = /\$\(([A-Za-z_][A-Za-z0-9_]*)\)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function expandMakeVars(text: string, vars: Map<string, string>, env: Record<string, string>, depth = 0): string {
  return text.replace(MAKE_VAR_REF, (_m, a: string | undefined, b: string | undefined) => {
    const name = (a ?? b)!;
    const value = env[name] ?? vars.get(name);
    if (value === undefined || depth > 5) return `$${name}`;
    return expandMakeVars(value, vars, env, depth + 1);
  });
}

export function parseMakefile(content: string): {
  rules: Map<string, { prereqs: string[]; recipe: string[] }>;
  vars: Map<string, string>;
  defaultTarget?: string;
} {
  const rules = new Map<string, { prereqs: string[]; recipe: string[] }>();
  const vars = new Map<string, string>();
  let defaultTarget: string | undefined;
  let current: { prereqs: string[]; recipe: string[] }[] = [];
  const lines = content.replace(/\\\n/g, ' ').split('\n');
  for (const line of lines) {
    if (line.startsWith('\t')) {
      for (const r of current) r.recipe.push(line.slice(1));
      continue;
    }
    const assign = /^(?:export\s+|override\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(\?|:{1,3}|\+|!)?=\s*(.*)$/.exec(line);
    if (assign) {
      const name = assign[1]!;
      const op = assign[2];
      const value = assign[3]!.trim();
      if (op === '!') vars.delete(name); // `!=` runs a shell command: value unknown
      else if (op === '+') vars.set(name, `${vars.get(name) ?? ''} ${value}`.trim());
      else if (op !== '?' || !vars.has(name)) vars.set(name, value);
      current = [];
      continue;
    }
    const m = /^([^:#=\s][^:#=]*?)\s*::?(?!=)\s*([^;#]*)(?:;(.*))?$/.exec(line);
    if (m) {
      const names = m[1]!.split(/\s+/).filter(Boolean);
      const prereqs = m[2]!.split(/\s+/).filter((p) => p && !p.startsWith('|'));
      current = names.map((name) => {
        const r = rules.get(name) ?? { prereqs: [], recipe: [] };
        r.prereqs.push(...prereqs);
        rules.set(name, r);
        if (!defaultTarget && !name.startsWith('.') && !name.includes('%')) defaultTarget = name;
        return r;
      });
      if (m[3]) for (const r of current) r.recipe.push(m[3]);
      continue;
    }
    if (line.trim() && !line.startsWith(' ')) current = [];
  }
  return { rules, vars, defaultTarget };
}

function handleJust(argv: string[], dir: string, via: string[], depth: number, env: Record<string, string>, ops: Operation[]): void {
  const path = ['justfile', 'Justfile', '.justfile'].map((f) => join(dir, f)).find((f) => existsSync(f));
  if (!path) return;
  const content = readSmall(path) ?? '';
  const recipes = new Map<string, { deps: string[]; body: string[] }>();
  let current: { deps: string[]; body: string[] } | undefined;
  let first: string | undefined;
  for (const line of content.split('\n')) {
    if (/^\s+\S/.test(line) && current) {
      current.body.push(line.trim());
      continue;
    }
    const m = /^@?([A-Za-z0-9_-]+)(?:\s+[^:=]*)?:(?!=)\s*(.*)$/.exec(line);
    if (m) {
      current = { deps: m[2]!.split(/\s+/).filter((d) => /^[A-Za-z0-9_-]+$/.test(d)), body: [] };
      recipes.set(m[1]!, current);
      first ??= m[1]!;
    } else if (line.trim()) current = undefined;
  }
  const target = argv.slice(1).find((a) => !a.startsWith('-')) ?? first;
  const seen = new Set<string>();
  const visit = (t: string) => {
    if (seen.has(t)) return;
    seen.add(t);
    const r = recipes.get(t);
    if (!r) return;
    r.deps.forEach(visit);
    for (const line of r.body) walk(line.replace(/^[@-]+/, '').replace(/\{\{[^}]*\}\}/g, 'JUSTVAR'), dir, [...via, `just ${t}`], depth + 1, env, ops, false);
  };
  if (target) visit(target);
}

function handlePackageScript(argv: string[], dir: string, via: string[], depth: number, env: Record<string, string>, ops: Operation[]): void {
  const pm = basename(argv[0]!);
  const args = argv.slice(1);
  let script: string | undefined;
  let extra: string[] = [];
  const first = args[0];
  if (first === 'run' || first === 'run-script' || (pm === 'bun' && first === 'run')) {
    const idx = args.findIndex((a, i) => i > 0 && !a.startsWith('-'));
    if (idx !== -1) {
      script = args[idx];
      extra = args.slice(idx + 1);
    }
  } else if (first === 'start' || first === 'test' || first === 't') {
    script = first === 't' ? 'test' : first;
    extra = args.slice(1);
  } else if ((pm === 'yarn' || pm === 'pnpm' || pm === 'bun') && first && !first.startsWith('-') && !PM_BUILTINS.has(first)) {
    script = first;
    extra = args.slice(1);
  }
  if (!script) return;
  if (extra[0] === '--') extra = extra.slice(1);

  const pkgPath = findUp(dir, 'package.json');
  if (!pkgPath) return;
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(readSmall(pkgPath) ?? '{}') as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return;
  }
  const pkgDir = dirname(pkgPath);
  const label = `${pm} run ${script}`;
  for (const name of [`pre${script}`, script, `post${script}`]) {
    const body = scripts[name];
    if (body === undefined) continue;
    const text = name === script && extra.length ? `${body} ${extra.map(shellQuote).join(' ')}` : body;
    // npm puts node_modules/.bin on PATH, so a bare `cdk` in a script is the local CDK CLI.
    walk(text, pkgDir, [...via, name === script ? label : `${label} (${name})`], depth + 1, env, ops, false);
  }
  if (scripts[script] === undefined && (pm === 'yarn' || pm === 'pnpm' || pm === 'bun')) {
    // `yarn cdk deploy` without a "cdk" script runs the cdk binary.
    walk([script, ...extra].map(shellQuote).join(' '), dir, [...via, `${pm} ${script}`], depth + 1, env, ops, false);
  }
}

function findUp(dir: string, file: string): string | undefined {
  let d = dir;
  for (let i = 0; i < 20; i++) {
    const p = join(d, file);
    if (existsSync(p)) return p;
    const parent = dirname(d);
    if (parent === d) return undefined;
    d = parent;
  }
  return undefined;
}

function readSmall(path: string): string | undefined {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
    const buf = readFileSync(path);
    if (buf.includes(0)) return undefined; // binary
    return buf.toString('utf8');
  } catch {
    return undefined;
  }
}

function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) return join(process.env.HOME ?? '~', p.slice(1));
  return p;
}

function stringEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./=:@%+,]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function clip(s: string, max = 200): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

