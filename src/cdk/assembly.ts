import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { globToRegExp } from '../findings.js';

export interface StackArtifact {
  /** Artifact id in the manifest. */
  id: string;
  /** Hierarchical display name (`Stage/Stack`), what users select with. */
  displayName: string;
  stackName: string;
  account?: string;
  region?: string;
  templateFile: string;
  terminationProtection: boolean;
  /** Ids of stack artifacts this one depends on. */
  dependencies: string[];
  /** True for stacks in the root assembly (not inside a Stage). */
  topLevel: boolean;
}

interface Manifest {
  artifacts?: Record<
    string,
    {
      type: string;
      environment?: string;
      displayName?: string;
      dependencies?: string[];
      properties?: {
        templateFile?: string;
        stackName?: string;
        terminationProtection?: boolean;
        directoryName?: string;
        displayName?: string;
      };
    }
  >;
}

export class AssemblyError extends Error {}

export function readAssembly(dir: string, topLevel = true, depth = 0): StackArtifact[] {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new AssemblyError(`no manifest.json in ${dir} (is this a cloud assembly?)`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  const out: StackArtifact[] = [];
  for (const [id, a] of Object.entries(manifest.artifacts ?? {})) {
    if (a.type === 'aws:cloudformation:stack') {
      const env = /^aws:\/\/([^/]+)\/(.+)$/.exec(a.environment ?? '');
      const account = env && env[1] !== 'unknown-account' ? env[1] : undefined;
      const region = env && env[2] !== 'unknown-region' ? env[2] : undefined;
      out.push({
        id,
        displayName: a.displayName ?? id,
        stackName: a.properties?.stackName ?? id,
        account,
        region,
        templateFile: resolve(dir, a.properties?.templateFile ?? `${id}.template.json`),
        terminationProtection: a.properties?.terminationProtection ?? false,
        dependencies: a.dependencies ?? [],
        topLevel,
      });
    } else if (a.type === 'cdk:cloud-assembly' && a.properties?.directoryName && depth < 10) {
      out.push(...readAssembly(resolve(dir, a.properties.directoryName), false, depth + 1));
    }
  }
  return out;
}

export function readTemplate(stack: StackArtifact): Record<string, unknown> {
  return JSON.parse(readFileSync(stack.templateFile, 'utf8')) as Record<string, unknown>;
}

/**
 * Mirror the CDK CLI's stack selection closely enough to analyse a superset of
 * what it will deploy. Over-selecting only costs an extra approval; under-selecting
 * would miss a destructive change.
 */
export function selectStacks(
  all: StackArtifact[],
  opts: { patterns: string[]; all: boolean; exclusively: boolean },
): StackArtifact[] {
  let selected: StackArtifact[];
  if (opts.patterns.length) {
    const res = opts.patterns.map(globToRegExp);
    selected = all.filter((s) => res.some((re) => re.test(s.displayName) || re.test(s.id) || re.test(s.stackName)));
  } else if (opts.all) {
    selected = all.filter((s) => s.topLevel);
  } else {
    const top = all.filter((s) => s.topLevel);
    selected = top.length ? top : all;
  }
  if (!opts.exclusively) {
    const byId = new Map(all.map((s) => [s.id, s]));
    const queue = [...selected];
    const seen = new Set(selected.map((s) => s.id));
    while (queue.length) {
      const s = queue.pop()!;
      for (const d of s.dependencies) {
        const dep = byId.get(d);
        if (dep && !seen.has(dep.id)) {
          seen.add(dep.id);
          selected.push(dep);
          queue.push(dep);
        }
      }
    }
  }
  return selected;
}
