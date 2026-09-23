import { tokenize, type OperatorValue, type RedirectToken, type WordToken } from './tokenize.js';

export interface SimpleCommand {
  words: WordToken[];
  redirects: RedirectToken[];
  /** Offset of the first token of this command in the original string. */
  start: number;
  end: number;
  /** Operator that precedes this command ('|' means stdin comes from a pipe). */
  precededBy?: OperatorValue;
  /** Operator that follows this command. */
  followedBy?: OperatorValue;
}

/** Split a shell string into simple commands (pipelines and lists flattened). */
export function parseCommands(input: string): SimpleCommand[] {
  const tokens = tokenize(input);
  const commands: SimpleCommand[] = [];
  let current: SimpleCommand | undefined;
  let lastOp: OperatorValue | undefined;

  const flush = (op?: OperatorValue) => {
    if (current && (current.words.length || current.redirects.length)) {
      current.followedBy = op;
      commands.push(current);
    }
    current = undefined;
  };

  for (const t of tokens) {
    if (t.type === 'op') {
      flush(t.value);
      lastOp = t.value;
      continue;
    }
    if (!current) {
      current = { words: [], redirects: [], start: t.start, end: t.end, precededBy: lastOp };
    }
    if (t.type === 'word') current.words.push(t);
    else current.redirects.push(t);
    current.end = t.end;
  }
  flush();
  return commands;
}

/**
 * Shell keywords that can prefix a command without changing what runs.
 * `for x in ...` / `case` bodies are split by ';' / newline, so stripping the
 * keyword is enough for detection.
 */
export const LEADING_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'time', 'function',
]);
