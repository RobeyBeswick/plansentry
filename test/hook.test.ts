import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandFrom, formatDecision, runHook } from '../src/hook/hook.js';
import { addHook, onPath, removeHook } from '../src/install.js';
import { parseExecArgs } from '../src/exec.js';

const input = (command: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ tool_name: 'Bash', cwd: '/tmp', permission_mode: 'default', tool_input: { command }, ...extra });

describe('hook protocol', () => {
  it('Claude: emits a PreToolUse deny as JSON with exit 0', () => {
    const r = runHook(input('terraform apply -auto-approve'), 'claude', {});
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('plansentry exec -- terraform apply -auto-approve');
  });

  it('Claude: ask for risky state operations, deny in bypassPermissions', () => {
    expect(JSON.parse(runHook(input('terraform state rm x'), 'claude', {}).stdout).hookSpecificOutput.permissionDecision).toBe('ask');
    const bypass = runHook(input('terraform state rm x', { permission_mode: 'bypassPermissions' }), 'claude', {});
    expect(JSON.parse(bypass.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('Codex: blocks with exit 2 and a stderr reason', () => {
    const r = runHook(input(['bash', '-lc', 'cdk deploy']), 'codex', {});
    expect(r).toMatchObject({ exitCode: 2, stdout: '' });
    expect(r.stderr).toContain('plansentry exec -- cdk deploy');
  });

  it('is silent for everything else', () => {
    expect(runHook(input('ls'), 'claude', {})).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(runHook(JSON.stringify({ tool_name: 'Edit', tool_input: { command: 'terraform apply' } }), 'claude', {}).stdout).toBe('');
    expect(runHook('{}', 'claude', {}).exitCode).toBe(0);
  });

  it('accepts plain text for generic callers', () => {
    expect(runHook('terraform destroy', 'generic', {}).exitCode).toBe(2);
  });

  it('unwraps Codex argv arrays and quotes others', () => {
    expect(commandFrom({ tool_input: { command: ['bash', '-lc', 'terraform apply'] } })).toBe('terraform apply');
    expect(commandFrom({ tool_input: { command: ['terraform', 'apply', '-var', 'a=b c'] } })).toBe("terraform apply -var 'a=b c'");
  });

  it('passes on "pass"', () => {
    expect(formatDecision({ kind: 'pass' }, 'codex').exitCode).toBe(0);
  });
});

describe('install', () => {
  it('adds the hook once and keeps other settings', () => {
    const base = { model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-guard' }] }] } };
    const once = addHook(base, 'claude');
    expect(once.changed).toBe(true);
    expect(once.settings.model).toBe('x');
    expect(once.settings.hooks!.PreToolUse).toHaveLength(2);
    expect(addHook(once.settings, 'claude').changed).toBe(false);
    const removed = removeHook(once.settings);
    expect(removed.changed).toBe(true);
    expect(removed.settings).toEqual(base);
  });

  it('checks that the hook command is on PATH', () => {
    const bin = mkdtempSync(join(tmpdir(), 'plansentry-bin-'));
    writeFileSync(join(bin, 'plansentry'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(bin, 'not-executable'), '');
    expect(onPath('plansentry', ['/nonexistent', bin].join(delimiter))).toBe(true);
    expect(onPath('not-executable', bin)).toBe(false);
    expect(onPath('plansentry', '/nonexistent')).toBe(false);
  });

  it('adds a statusMessage for Codex', () => {
    const { settings } = addHook({}, 'codex');
    expect(settings.hooks!.PreToolUse![0]!.hooks![0]).toMatchObject({ command: 'plansentry hook --agent codex', statusMessage: expect.any(String) });
  });
});

describe('exec argument parsing', () => {
  it('parses flags and the command', () => {
    expect(parseExecArgs(['--ack', 'abcdef012345', '--offline', '--', 'cdk', 'deploy'])).toMatchObject({ ack: 'abcdef012345', offline: true, argv: ['cdk', 'deploy'] });
    expect(parseExecArgs(['terraform', 'apply'])).toMatchObject({ argv: ['terraform', 'apply'] });
  });

  it('rejects malformed acks and empty commands', () => {
    expect(parseExecArgs(['--ack', 'yes', '--', 'terraform', 'apply'])).toMatch(/12-character/);
    expect(parseExecArgs(['--'])).toMatch(/no command/);
    expect(parseExecArgs(['--force', 'terraform'])).toMatch(/unknown option/);
  });
});
