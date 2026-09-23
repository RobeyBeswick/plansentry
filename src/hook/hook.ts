import { readFileSync } from 'node:fs';
import { shellQuote } from '../detect.js';
import { decide, type Agent, type Decision } from './decide.js';

interface HookInput {
  cwd?: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: { command?: unknown };
  /** Generic callers may send just `{ "command": "..." }`. */
  command?: unknown;
}

/** Codex has sent both a string and an argv array (`["bash", "-lc", "..."]`). */
export function commandFrom(input: HookInput): string | undefined {
  const raw = input.tool_input?.command ?? input.command;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.every((x) => typeof x === 'string')) {
    const argv = raw as string[];
    if (argv.length === 3 && /(^|\/)(ba|z)?sh$/.test(argv[0]!) && /^-l?c$|^-cl$/.test(argv[1]!)) return argv[2];
    return argv.map(shellQuote).join(' ');
  }
  return undefined;
}

export interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function formatDecision(decision: Decision, agent: Agent): HookResult {
  if (decision.kind === 'pass') return { exitCode: 0, stdout: '', stderr: '' };
  if (agent === 'claude') {
    const out = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision.kind,
        permissionDecisionReason: decision.reason,
      },
    };
    return { exitCode: 0, stdout: `${JSON.stringify(out)}\n`, stderr: '' };
  }
  // Codex and generic agents: exit 2 blocks the call and shows stderr to the model.
  return { exitCode: 2, stdout: '', stderr: `${decision.reason}\n` };
}

export function runHook(raw: string, agent: Agent, env: NodeJS.ProcessEnv = process.env): HookResult {
  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    // Plain text: treat it as the command (handy for `echo "cmd" | plansentry hook`).
    input = { command: raw.trim() };
  }
  if (input.tool_name && !/^(Bash|shell|exec_command|local_shell|run_shell_command)$/i.test(input.tool_name)) {
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  const command = commandFrom(input);
  if (!command) return { exitCode: 0, stdout: '', stderr: '' };
  const decision = decide(command, {
    cwd: input.cwd ?? process.cwd(),
    env,
    agent,
    permissionMode: input.permission_mode,
  });
  return formatDecision(decision, agent);
}

export function hookMain(agent: Agent): number {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    return 0;
  }
  const res = runHook(raw, agent);
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  return res.exitCode;
}
