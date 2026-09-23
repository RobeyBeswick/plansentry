import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Real terraform, built-in provider only (no downloads). Needs `npm run build` first.
const CLI = resolve(__dirname, '../dist/cli.js');
const hasTerraform = spawnSync('terraform', ['version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!hasTerraform || !existsSync(CLI))('terraform end to end', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plansentry-e2e-'));
  const env = { ...process.env, PLANSENTRY_NONINTERACTIVE: '1', NO_COLOR: '1', TF_IN_AUTOMATION: '1' };
  const run = (...args: string[]) => spawnSync('node', [CLI, ...args], { cwd: dir, env, encoding: 'utf8', timeout: 120_000 });
  const config = (v: string) => writeFileSync(join(dir, 'main.tf'), `resource "terraform_data" "db" {\n  triggers_replace = "${v}"\n}\n`);

  it('applies safe changes, blocks a replacement, and applies it after the right ack', () => {
    writeFileSync(join(dir, '.plansentry.json'), JSON.stringify({ statefulTypes: { add: ['terraform_data'] } }));
    config('v1');
    expect(spawnSync('terraform', ['init', '-input=false'], { cwd: dir, env, encoding: 'utf8' }).status).toBe(0);

    expect(run('exec', '--', 'terraform', 'apply', '-auto-approve').status).toBe(0);

    config('v2');
    const blocked = run('exec', '--', 'terraform', 'apply', '-auto-approve');
    expect(blocked.status).toBe(3);
    const out = blocked.stdout + blocked.stderr;
    expect(out).toContain('terraform_data.db');
    const rerun = /plansentry exec --ack ([a-f0-9]{12}) -- terraform apply (\S+\.tfplan)/.exec(out);
    expect(rerun).not.toBeNull();
    const [, digest, planFile] = rerun!;

    expect(run('exec', '--ack', '000000000000', '--', 'terraform', 'apply', planFile!).status).toBe(3);
    expect(run('exec', '--ack', digest!, '--', 'terraform', 'apply', planFile!).status).toBe(0);
    expect(readdirSync(join(dir, '.plansentry', 'plans'))).toHaveLength(0);

    expect(run('exec', '--', 'terraform', 'apply', '-auto-approve').status).toBe(0);
  }, 180_000);
});
