import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeCdkDestroy, analyzeCdkStack } from '../src/cdk/analyze.js';
import { readAssembly, selectStacks } from '../src/cdk/assembly.js';
import { DEFAULT_CONFIG, type Config } from '../src/policy/config.js';
import { evaluate } from '../src/policy/evaluate.js';

const cfg = (over: Partial<Config> = {}): Config => ({ ...structuredClone(DEFAULT_CONFIG), ...over });
type Res = Record<string, unknown>;
const tpl = (resources: Record<string, Res>) => ({ Resources: resources });

const table = (keyName: string, extra: Res = {}): Res => ({
  Type: 'AWS::DynamoDB::Table',
  Properties: { KeySchema: [{ AttributeName: keyName, KeyType: 'HASH' }], AttributeDefinitions: [{ AttributeName: keyName, AttributeType: 'S' }], BillingMode: 'PAY_PER_REQUEST' },
  UpdateReplacePolicy: 'Delete',
  DeletionPolicy: 'Delete',
  ...extra,
});
const bucket = (extra: Res = {}): Res => ({ Type: 'AWS::S3::Bucket', UpdateReplacePolicy: 'Delete', DeletionPolicy: 'Delete', ...extra });
const topic: Res = { Type: 'AWS::SNS::Topic' };

const byAddress = (a: ReturnType<typeof analyzeCdkStack>) => Object.fromEntries(a.findings.map((f) => [f.address, f]));

describe('analyzeCdkStack', () => {
  it('flags a table replacement forced by a key change', () => {
    const a = analyzeCdkStack({ stack: 'Data', before: tpl({ Orders: table('id') }), after: tpl({ Orders: table('orderId') }) }, cfg());
    const f = byAddress(a)['Data/Orders']!;
    expect(f).toMatchObject({ severity: 'danger', change: 'replace', type: 'AWS::DynamoDB::Table' });
    expect(f.notes.join()).toContain('KeySchema');
    expect(evaluate(a, cfg()).needsApproval).toBe(true);
  });

  it('downgrades retained resources to warn/orphan', () => {
    const a = analyzeCdkStack({ stack: 'Data', before: tpl({ Keep: bucket({ DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' }) }), after: tpl({}) }, cfg());
    expect(byAddress(a)['Data/Keep']).toMatchObject({ severity: 'warn', change: 'orphan' });
  });

  it('keeps danger when a retained resource is replaced but the new policy is Delete', () => {
    const before = tpl({ T: table('id', { UpdateReplacePolicy: 'Retain', DeletionPolicy: 'Retain' }) });
    const after = tpl({ T: table('pk') });
    expect(byAddress(analyzeCdkStack({ stack: 'S', before, after }, cfg()))['S/T']!.severity).toBe('danger');
  });

  it('notes autoDeleteObjects on bucket removal', () => {
    const before = tpl({
      Logs: bucket(),
      LogsAutoDelete: { Type: 'Custom::S3AutoDeleteObjects', Properties: { BucketName: { Ref: 'Logs' } } },
    });
    const a = analyzeCdkStack({ stack: 'S', before, after: tpl({}) }, cfg());
    expect(byAddress(a)['S/Logs']!.notes.join()).toMatch(/auto.?delete/i);
  });

  it('warns when deletion protection or DeletionPolicy is weakened', () => {
    const db = (dp: boolean, policy: string): Res => ({
      Type: 'AWS::RDS::DBCluster',
      Properties: { Engine: 'aurora-postgresql', DeletionProtection: dp },
      DeletionPolicy: policy,
      UpdateReplacePolicy: policy,
    });
    const a = analyzeCdkStack({ stack: 'S', before: tpl({ Db: db(true, 'Snapshot') }), after: tpl({ Db: db(false, 'Delete') }) }, cfg());
    const f = a.findings.filter((x) => x.address === 'S/Db');
    expect(f.length).toBeGreaterThan(0);
    expect(f.every((x) => x.change === 'weaken' && x.severity === 'warn')).toBe(true);
  });

  it('ignores non-stateful churn and pure creates', () => {
    const a = analyzeCdkStack({ stack: 'S', before: tpl({ T: topic }), after: tpl({ Q: { Type: 'AWS::SQS::Queue' }, N: table('id') }) }, cfg());
    expect(evaluate(a, cfg()).needsApproval).toBe(false);
    expect(a.counts.create).toBe(2);
  });

  it('respects ignore globs on the Stack/LogicalId address', () => {
    const a = analyzeCdkStack({ stack: 'Scratch', before: tpl({ Orders: table('id') }), after: tpl({}) }, cfg({ ignore: ['Scratch/*'] }));
    expect(a.findings).toHaveLength(0);
  });

  it('destroy diff treats every stateful resource as danger unless retained', () => {
    const a = analyzeCdkDestroy('S', tpl({ Orders: table('id'), Keep: bucket({ DeletionPolicy: 'Retain' }), T: topic }), cfg());
    const f = byAddress(a);
    expect(f['S/Orders']!.severity).toBe('danger');
    expect(f['S/Keep']!.severity).toBe('warn');
    expect(evaluate(a, cfg()).gating.map((g) => g.address)).toContain('S/Orders');
  });
});

describe('cloud assembly', () => {
  function assembly(): string {
    const dir = mkdtempSync(join(tmpdir(), 'plansentry-asm-'));
    const stack = (id: string, deps: string[] = []) => ({
      type: 'aws:cloudformation:stack',
      environment: 'aws://123456789012/eu-central-1',
      properties: { templateFile: `${id}.template.json`, stackName: id },
      dependencies: deps,
      displayName: id,
    });
    writeFileSync(join(dir, 'Net.template.json'), '{}');
    writeFileSync(join(dir, 'Data.template.json'), '{}');
    mkdirSync(join(dir, 'assembly-Prod'));
    writeFileSync(join(dir, 'assembly-Prod', 'ProdApp.template.json'), '{}');
    writeFileSync(
      join(dir, 'assembly-Prod', 'manifest.json'),
      JSON.stringify({ version: '36.0.0', artifacts: { ProdApp: { ...stack('ProdApp'), displayName: 'Prod/App' } } }),
    );
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        version: '36.0.0',
        artifacts: {
          Net: stack('Net'),
          Data: stack('Data', ['Net']),
          Prod: { type: 'cdk:cloud-assembly', properties: { directoryName: 'assembly-Prod' } },
        },
      }),
    );
    return dir;
  }

  it('reads nested assemblies and account/region', () => {
    const stacks = readAssembly(assembly());
    expect(stacks.map((s) => s.displayName).sort()).toEqual(['Data', 'Net', 'Prod/App']);
    expect(stacks.find((s) => s.id === 'Data')).toMatchObject({ account: '123456789012', region: 'eu-central-1', dependencies: ['Net'] });
  });

  it('selects dependencies unless exclusively', () => {
    const all = readAssembly(assembly());
    expect(selectStacks(all, { patterns: ['Data'], all: false, exclusively: false }).map((s) => s.id).sort()).toEqual(['Data', 'Net']);
    expect(selectStacks(all, { patterns: ['Data'], all: false, exclusively: true }).map((s) => s.id)).toEqual(['Data']);
    expect(selectStacks(all, { patterns: ['Prod/*'], all: false, exclusively: false }).map((s) => s.displayName)).toEqual(['Prod/App']);
  });
});
