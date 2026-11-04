#!/usr/bin/env node
// Scripted requests, real Terraform and PlanSentry, synthetic data in local Moto.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`PlanSentry recording demo

  npm run demo            Press Enter to advance each scene.
  npm run demo -- --auto   Rehearse without pauses or screen clearing.

Requires Node.js 22+, Terraform 1.5+, and uv. First run downloads Moto and
the Terraform AWS provider; subsequent runs reuse their download caches.
After building, use node scripts/demo.mjs for a clean recording start.

Two private local mocks contain synthetic orders and invoices. The unguarded
copy is deliberately replaced and loses its data. PlanSentry protects the other.
No live model, cloud account, global install, or agent settings are needed.
Non-interactive input/output automatically uses --auto mode.`);
  process.exit(0);
}
if (args.some(arg => arg !== '--auto')) {
  console.error('Unknown option. Use --auto or --help.');
  process.exit(1);
}

const checkout = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '');
const cli = join(checkout, 'dist', 'cli.js');
if (!existsSync(cli)) {
  console.error('Build PlanSentry first: npm run build');
  process.exit(1);
}
const interactive = !args.includes('--auto') && process.stdin.isTTY && process.stdout.isTTY;
const color = process.stdout.isTTY && !('NO_COLOR' in process.env);
const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
const width = Math.min(96, Math.max(40, (process.stdout.columns ?? 96) - 2));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'plansentry-demo-')));
const cache = join(checkout, '.demo-cache', 'terraform');
const children = new Set();
let terminal;
let finishing = false;

// Isolate profiles, endpoint overrides, CLI arguments, credentials and approval summaries.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AWS_|TF_|TFE_|MOTO_)/.test(key))),
  AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test',
  AWS_REGION: 'eu-central-1', AWS_DEFAULT_REGION: 'eu-central-1',
  AWS_EC2_METADATA_DISABLED: 'true', AWS_CONFIG_FILE: join(root, 'empty-config'),
  AWS_SHARED_CREDENTIALS_FILE: join(root, 'empty-config'),
  TF_CLI_CONFIG_FILE: join(root, 'terraform.rc'), TF_PLUGIN_CACHE_DIR: cache,
  TF_IN_AUTOMATION: '1', TF_INPUT: '0', CHECKPOINT_DISABLE: '1',
  PLANSENTRY_NONINTERACTIVE: '1', NO_COLOR: '1',
  TMPDIR: root, TMP: root, TEMP: root,
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
};
const replacements = [
  [join(root, 'guarded'), '<demo>'], [join(root, 'unguarded'), '<control>'],
  [root, '<demo-temp>'], [checkout, '<checkout>'], [homedir(), '~'],
].sort(([a], [b]) => b.length - a.length);
const sanitize = text => replacements.reduce((value, [path, alias]) =>
  value.replaceAll(path, alias).replaceAll(path.replaceAll('\\', '/'), alias), String(text));
const quote = text => /^[a-zA-Z0-9_./:=+-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;

function print(text = '') {
  for (const original of sanitize(text).split('\n')) {
    let remaining = original;
    const indent = original.match(/^\s*/)[0];
    while (remaining.length > width) {
      const space = remaining.lastIndexOf(' ', width);
      const end = space > indent.length ? space : width;
      console.log(remaining.slice(0, end));
      remaining = indent + remaining.slice(end).trimStart();
    }
    console.log(remaining);
  }
}

function stop(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function childProcess(executable, argv, cwd) {
  const child = spawn(executable, argv, {
    cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}

function run(executable, argv, cwd, input = '', timeout = 60_000) {
  return new Promise((resolve, reject) => {
    const child = childProcess(executable, argv, cwd);
    let stdout = '', stderr = '', failure;
    const timer = setTimeout(() => {
      failure = new Error(`${executable} timed out after ${timeout / 1000}s`);
      stop(child);
    }, timeout);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { failure = error; });
    child.stdin.on('error', error => { failure ??= error; });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      if (failure || signal) reject(new Error(`${failure?.message ?? signal}\n${stderr}`));
      else resolve({ status, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function expectExit(result, status, label) {
  assert.equal(result.status, status, `${label}\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function startMock() {
  const child = childProcess('uv', [
    'run', '--no-project', '--python', '3.12', '--with', 'moto[server]==5.2.2',
    'python', join(checkout, 'scripts', 'demo', 'mock.py'),
  ], root);
  let stderr = '', pending, failure;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  const lines = createInterface({ input: child.stdout });
  const queue = [];
  lines.on('line', line => {
    if (pending) { const receive = pending; pending = undefined; receive.resolve(line); }
    else queue.push(line);
  });
  const fail = error => {
    failure = error;
    if (pending) { pending.reject(error); pending = undefined; }
  };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('close', code => fail(new Error(`Demo mock exited (${code}).\n${stderr}`)));
  async function receive(timeout) {
    let timer;
    try {
      if (failure) throw failure;
      const line = queue.length ? queue.shift() : await new Promise((resolve, reject) => {
        pending = { resolve, reject };
        timer = setTimeout(() => {
          pending = undefined;
          reject(new Error(`Demo mock timed out.\n${stderr}`));
        }, timeout);
      });
      const result = JSON.parse(line);
      if (result.error) throw new Error(result.error);
      return result;
    } finally { clearTimeout(timer); }
  }
  const ready = await receive(180_000);
  assert.match(ready.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
  const mock = {
    endpoint: ready.endpoint,
    async request(action, prefix = '') {
      child.stdin.write(`${JSON.stringify({ action, prefix })}\n`);
      return receive(30_000);
    },
  };
  return mock;
}

const template = readFileSync(join(checkout, 'scripts', 'demo', 'main.tf'), 'utf8');
function configure(fixture, { safe = false, rename = false } = {}) {
  let text = template;
  if (safe) text = text.replace('Demo = "before"', 'Demo = "recording"');
  if (rename) text = text.replace('= "orders"', '= "shop-orders"').replace('= "invoices"', '= "shop-invoices"');
  writeFileSync(join(fixture.cwd, 'main.tf'), text);
}

async function setup(name) {
  const mock = await startMock();
  const cwd = join(root, name);
  mkdirSync(cwd);
  const fixture = { cwd, mock };
  configure(fixture);
  // An empty policy prevents discovery of any policy in a parent directory.
  writeFileSync(join(cwd, '.plansentry.json'), '{}\n');
  writeFileSync(join(cwd, 'provider.tf'), `terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = { source = "hashicorp/aws", version = "= 5.100.0" }
  }
}
provider "aws" {
  region = "eu-central-1"
  access_key = "test"
  secret_key = "test"
  skip_credentials_validation = true
  skip_metadata_api_check = true
  skip_requesting_account_id = true
  s3_use_path_style = true
  endpoints {
    dynamodb = "${mock.endpoint}"
    s3 = "${mock.endpoint}"
    sts = "${mock.endpoint}"
  }
}
`);
  expectExit(await run('terraform', ['init', '-input=false', '-no-color'], cwd, '', 180_000), 0, 'Terraform init failed');
  expectExit(await run('terraform', ['apply', '-auto-approve', '-input=false', '-no-color'], cwd), 0, 'Fixture creation failed');
  await mock.request('seed');
  fixture.before = await mock.request('snapshot');
  assert.equal(fixture.before.orders.length, 25);
  assert.equal(Object.keys(fixture.before.invoices).length, 3);
  return fixture;
}

const exec = (fixture, ...argv) => run(process.execPath, [cli, 'exec', ...argv], fixture.cwd);
async function hook(fixture, command, agent = 'generic', permissionMode = 'default') {
  return run(process.execPath, [cli, 'hook', '--agent', agent], fixture.cwd, JSON.stringify({
    tool_name: 'Bash', cwd: fixture.cwd, permission_mode: permissionMode, tool_input: { command },
  }));
}
function showReport(result) {
  // Keep PlanSentry's report verbatim; Terraform's progress output is captured.
  const start = result.stderr.indexOf('plansentry: no destructive');
  const blocked = result.stderr.indexOf('plansentry: 2 item(s)');
  const offset = start >= 0 ? start : blocked;
  assert.ok(offset >= 0, `Missing PlanSentry report:\n${result.stderr}`);
  const text = result.stderr.slice(offset);
  const end = text.indexOf('\n\nHeld for approval:');
  print((end >= 0 ? text.slice(0, end) : text).trimEnd());
}
async function verifyPreserved(fixture) {
  const snapshot = await fixture.mock.request('snapshot');
  assert.deepEqual(snapshot, fixture.before, 'Every order field and invoice byte must survive.');
  assert.deepEqual(await fixture.mock.request('snapshot', 'shop-'), { orders: null, invoices: null });
  return snapshot;
}
function counts(snapshot) {
  print(`  Orders awaiting shipment   ${snapshot.orders.length}`);
  print(`  Invoices retained          ${Object.keys(snapshot.invoices).length}`);
}
function screen(title) {
  if (interactive) process.stdout.write('\x1b[2J\x1b[H');
  else print();
  console.log(paint('1', 'PlanSentry'));
  console.log(paint('2', 'Scripted requests | real Terraform + guard | local AWS mocks'));
  print('-'.repeat(width));
  console.log(paint('1', title));
  print();
}
async function next(label) {
  if (!interactive) return;
  print();
  await new Promise(resolve => terminal.question(`Enter: ${label}  |  Ctrl-C: quit `, resolve));
}
function cleanup() {
  finishing = true;
  terminal?.close();
  for (const child of children) stop(child);
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
process.once('exit', cleanup);
process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));

try {
  mkdirSync(cache, { recursive: true });
  writeFileSync(env.TF_CLI_CONFIG_FILE, 'disable_checkpoint = true\n');
  writeFileSync(env.AWS_CONFIG_FILE, '');
  print('Preparing two disposable shops (first run downloads demo dependencies)...');
  for (const [bin, argv] of [['terraform', ['version', '-json']], ['uv', ['--version']]]) {
    expectExit(await run(bin, argv, root), 0, `Missing prerequisite: ${bin}`);
  }
  const guarded = await setup('guarded');
  const control = await setup('unguarded');
  assert.deepEqual(control.before, guarded.before, 'Both shops must start with identical data.');
  if (interactive) {
    terminal = createInterface({ input: process.stdin, output: process.stdout });
    terminal.on('SIGINT', () => process.exit(130));
    terminal.on('close', () => { if (!finishing) process.exit(0); });
  }

  screen('"Just rename the resources."');
  print('25 paid orders waiting to ship. Three invoices to keep.');
  print('One routine-looking change can replace the resources holding them.');
  print();
  print('Two identical disposable shops. Synthetic data in private local mocks.');
  print('The control really loses its data. The guarded shop keeps every record.');
  print('No live model. No cloud account. Decisions and data checks are real.');
  await next('meet the shop');

  screen('1 / 5   Something worth protecting');
  counts(guarded.before);
  print();
  const order = guarded.before.orders[0];
  const [invoiceName, invoiceBody] = Object.entries(guarded.before.invoices).sort()[0];
  print(`  ${order.id.S}  |  ${order.customer.S}  |  ${order.status.S}`);
  print(`  ${invoiceName}  |  ${invoiceBody.trimEnd().split('\n').at(-1)}`);
  print();
  print('These values were read back from the table and bucket.');
  const routine = expectExit(await hook(guarded, 'terraform plan'), 0, 'Read-only hook should pass');
  assert.equal(routine.stdout + routine.stderr, '');
  print('Read-only terraform plan request: hook PASS (inspection only).');
  await next('a safe change');

  screen('2 / 5   Routine work goes through');
  print('Change a tag: Demo = "before" -> "recording"');
  print('  plansentry exec -- terraform apply -auto-approve');
  print();
  configure(guarded, { safe: true });
  const safe = expectExit(await exec(guarded, '--', 'terraform', 'apply', '-auto-approve'), 0, 'Tag update should pass');
  assert.match(safe.stderr, /0 to add, 1 to change, 0 to destroy, 0 to replace/);
  showReport(safe);
  print();
  console.log(paint('32;1', 'APPLIED'));
  counts(await verifyPreserved(guarded));
  print('Verified: every order field and invoice byte is unchanged.');
  // Give the control the identical starting configuration for the rename.
  configure(control, { safe: true });
  expectExit(await run('terraform', ['apply', '-auto-approve', '-input=false', '-no-color'], control.cwd), 0, 'Control tag update failed');
  assert.deepEqual(await control.mock.request('snapshot'), control.before);
  await next('the unguarded rename');

  screen('3 / 5   Without PlanSentry: success, with empty resources');
  print('Scripted request: "Add shop- to every resource name and apply."');
  print('  orders -> shop-orders     invoices -> shop-invoices');
  print('  terraform apply -auto-approve');
  print();
  configure(control, { safe: true, rename: true });
  const unguarded = expectExit(await run('terraform', ['apply', '-auto-approve', '-input=false', '-no-color'], control.cwd), 0, 'Control replacement failed');
  const summary = unguarded.stdout.match(/Apply complete! Resources: .*$/m)?.[0];
  assert.ok(summary, 'Terraform must report a successful apply.');
  print(summary);
  const lost = await control.mock.request('snapshot', 'shop-');
  assert.deepEqual(lost, { orders: [], invoices: {} }, 'Replacement resources must exist and be empty.');
  assert.deepEqual(await control.mock.request('snapshot'), { orders: null, invoices: null }, 'Original resources must be gone.');
  print();
  console.log(paint('31;1', 'DATA LOST IN THE DISPOSABLE CONTROL'));
  counts(lost);
  print('Verified: the old table and bucket are gone. The new ones are empty.');
  print('The guarded shop is a separate mock; its data is still intact.');
  await next('the same rename, guarded');

  screen('4 / 5   With PlanSentry: stop before the data is lost');
  configure(guarded, { safe: true, rename: true });
  const redirected = expectExit(await hook(guarded, 'terraform apply -auto-approve'), 2, 'Apply must be redirected');
  assert.match(redirected.stderr, /plansentry exec -- terraform apply -auto-approve/);
  print('Real hook redirects the apply through:');
  print('  plansentry exec -- terraform apply -auto-approve');
  print();
  const stateBefore = readFileSync(join(guarded.cwd, 'terraform.tfstate'));
  const blocked = expectExit(await exec(guarded, '--', 'terraform', 'apply', '-auto-approve'), 3, 'Replacement must need approval');
  for (const evidence of ['aws_dynamodb_table.orders', 'aws_s3_bucket.invoices', 'forced by: name', 'forced by: bucket', 'Nothing was applied']) {
    assert.ok(blocked.stderr.includes(evidence), `Missing evidence: ${evidence}`);
  }
  showReport(blocked);
  assert.deepEqual(readFileSync(join(guarded.cwd, 'terraform.tfstate')), stateBefore);
  print();
  console.log(paint('32;1', 'BLOCKED. DATA PRESERVED.'));
  counts(await verifyPreserved(guarded));
  const approval = blocked.stderr.split('\n').map(line => line.trim()).find(line => line.startsWith('plansentry exec --ack '));
  assert.ok(approval, 'The real CLI must supply an approval command.');
  const digest = /--ack ([a-f0-9]{12})/.exec(approval)?.[1];
  assert.ok(digest);
  const plan = join(guarded.cwd, '.plansentry', 'plans', `${digest}.tfplan`);
  assert.equal(approval, ['plansentry', 'exec', '--ack', digest, '--', 'terraform', 'apply', plan].map(quote).join(' '));
  assert.ok(existsSync(plan), 'The checked plan must be saved.');
  await next('who gets to approve');

  screen('5 / 5   The human decides');
  print('The real CLI saved the checked plan and returned:');
  print(`  ${approval}`);
  print();
  const asked = expectExit(await hook(guarded, approval, 'claude'), 0, 'Approval hook failed');
  const decision = JSON.parse(asked.stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, 'ask');
  assert.match(decision.permissionDecisionReason, /replace aws_dynamodb_table\.orders/);
  assert.match(decision.permissionDecisionReason, /replace aws_s3_bucket\.invoices/);
  print('Real Claude hook response (replayed; no agent UI is running):');
  console.log(paint('33;1', 'ASK HUMAN'));
  print(decision.permissionDecisionReason);
  for (const [agent, mode] of [['generic', 'default'], ['claude', 'bypassPermissions']]) {
    const denied = await hook(guarded, approval, agent, mode);
    if (agent === 'generic') {
      expectExit(denied, 2, 'A session without prompts must stop');
      assert.match(denied.stderr, /Stop and ask the user/);
    } else {
      expectExit(denied, 0, 'Claude hook must return a structured denial');
      assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
    }
  }
  print();
  print('Sessions without a permission prompt are told to stop for the human.');
  print('This replay leaves the destructive plan unapproved.');
  const preserved = await verifyPreserved(guarded);
  assert.deepEqual(readFileSync(join(guarded.cwd, 'terraform.tfstate')), stateBefore);
  assert.ok(existsSync(plan), 'No approval or apply may consume the held plan.');
  await next('closing card');

  screen('The apply can succeed. Your data can still disappear.');
  print('Same rename. Two measured outcomes:');
  print();
  print('                         Orders      Invoices');
  print(`  Without PlanSentry     ${lost.orders.length}           ${Object.keys(lost.invoices).length}`);
  print(`  With PlanSentry        ${preserved.orders.length}          ${Object.keys(preserved.invoices).length}`);
  print();
  print('Read the plan. Stop before data is destroyed.');
  print('A guard against mistakes, not a sandbox against a malicious agent.');
  print();
  print('Try it from the checkout: npm run demo');
  await next('finish and remove the temporary shops');
  cleanup();
  process.removeListener('exit', cleanup);
  print();
  print('Demo complete. Both mocks stopped; temporary shops removed.');
} catch (error) {
  console.error(sanitize(`Demo failed: ${error instanceof Error ? error.message : error}`));
  cleanup();
  process.removeListener('exit', cleanup);
  process.exitCode = 1;
}
