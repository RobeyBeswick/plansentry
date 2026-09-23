/**
 * A small POSIX-ish shell tokenizer. It is not a full shell: it only needs to
 * recover enough structure to find IaC commands reliably and to know where a
 * command starts in the original string (so the hook can rewrite it).
 *
 * Anything whose value can't be known statically ($VAR, $(...), backticks) is
 * flagged `dynamic` so callers can fail closed.
 */

export interface WordToken {
  type: 'word';
  /** Unquoted, unescaped value. Dynamic parts are kept verbatim (e.g. "$HOME"). */
  value: string;
  start: number;
  end: number;
  /** True if the word contains an expansion whose value is unknown statically. */
  dynamic: boolean;
  /** Bodies of $(...) and `...` command substitutions inside this word. */
  substitutions: string[];
}

export type OperatorValue = '&&' | '||' | ';' | '|' | '|&' | '&' | '\n' | '(' | ')';

export interface OperatorToken {
  type: 'op';
  value: OperatorValue;
  start: number;
  end: number;
}

export interface RedirectToken {
  type: 'redirect';
  value: string;
  start: number;
  end: number;
  /** For here-documents: the body text. For here-strings: the string. */
  heredoc?: string;
}

export type Token = WordToken | OperatorToken | RedirectToken;

export class ShellSyntaxError extends Error {}

const OPERATOR_CHARS = new Set(['&', '|', ';', '(', ')', '\n']);
const WORD_BREAK = new Set([' ', '\t', '\r', '\n', '&', '|', ';', '(', ')', '<', '>']);

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const pendingHeredocs: { delimiter: string; stripTabs: boolean; token: RedirectToken }[] = [];
  let i = 0;
  const n = input.length;

  const readHeredocBodies = () => {
    // Called right after a newline has been consumed.
    for (const h of pendingHeredocs.splice(0)) {
      const lines: string[] = [];
      while (i < n) {
        let lineEnd = input.indexOf('\n', i);
        if (lineEnd === -1) lineEnd = n;
        let line = input.slice(i, lineEnd);
        i = Math.min(lineEnd + 1, n);
        if (h.stripTabs) line = line.replace(/^\t+/, '');
        if (line === h.delimiter) break;
        lines.push(line);
      }
      h.token.heredoc = lines.join('\n');
    }
  };

  while (i < n) {
    const c = input[i]!;

    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '\\' && input[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '#') {
      while (i < n && input[i] !== '\n') i++;
      continue;
    }

    if (OPERATOR_CHARS.has(c)) {
      const start = i;
      const two = input.slice(i, i + 2);
      let value: OperatorValue;
      if (two === '&&' || two === '||' || two === '|&') {
        value = two;
        i += 2;
      } else if (c === '&' && input[i + 1] === '>') {
        // &> file  (redirect stdout+stderr)
        i = readRedirect(input, i, tokens, pendingHeredocs);
        continue;
      } else {
        value = c as OperatorValue;
        i++;
      }
      // ;; in case statements behaves like a separator for our purposes.
      if (value === ';' && input[i] === ';') i++;
      tokens.push({ type: 'op', value, start, end: i });
      if (value === '\n' && pendingHeredocs.length) readHeredocBodies();
      continue;
    }

    // Redirections, optionally with a leading fd number (2>, 2>&1, 0<).
    if (c === '<' || c === '>' || (/[0-9]/.test(c) && isFdRedirect(input, i))) {
      i = readRedirect(input, i, tokens, pendingHeredocs);
      continue;
    }

    const word = readWord(input, i);
    tokens.push(word.token);
    i = word.end;
  }

  if (pendingHeredocs.length) {
    // Heredoc without a trailing newline: body is empty.
    for (const h of pendingHeredocs) h.token.heredoc = '';
  }
  return tokens;
}

function isFdRedirect(input: string, i: number): boolean {
  let j = i;
  while (j < input.length && /[0-9]/.test(input[j]!)) j++;
  if (input[j] !== '<' && input[j] !== '>') return false;
  // Only counts if the digits start a word.
  return i === 0 || WORD_BREAK.has(input[i - 1]!);
}

function readRedirect(
  input: string,
  i: number,
  tokens: Token[],
  pendingHeredocs: { delimiter: string; stripTabs: boolean; token: RedirectToken }[],
): number {
  const start = i;
  while (i < input.length && /[0-9&]/.test(input[i]!)) i++;
  let op = '';
  while (i < input.length && (input[i] === '<' || input[i] === '>' || input[i] === '&' || input[i] === '|' || input[i] === '-')) {
    op += input[i];
    i++;
    if (op === '<<<' || op === '<<-' || op === '>&' || op === '<&' || op === '>|') break;
  }
  const token: RedirectToken = { type: 'redirect', value: input.slice(start, i), start, end: i };
  tokens.push(token);

  // Skip whitespace, then read the target word (file, fd, heredoc delimiter).
  while (i < input.length && (input[i] === ' ' || input[i] === '\t')) i++;
  if (i >= input.length || OPERATOR_CHARS.has(input[i]!)) return i;
  // fd duplication like 2>&1: the target is just the digit(s) / '-'.
  const target = readWord(input, i);
  token.end = target.end;

  if (op.startsWith('<<<')) {
    token.heredoc = target.token.value;
  } else if (op.startsWith('<<')) {
    pendingHeredocs.push({ delimiter: target.token.value, stripTabs: op === '<<-', token });
  }
  return target.end;
}

function readWord(input: string, start: number): { token: WordToken; end: number } {
  let i = start;
  let value = '';
  let dynamic = false;
  const substitutions: string[] = [];
  const n = input.length;

  while (i < n) {
    const c = input[i]!;
    if (WORD_BREAK.has(c)) break;

    if (c === '\\') {
      if (input[i + 1] === '\n') {
        i += 2;
        continue;
      }
      if (i + 1 < n) value += input[i + 1];
      i += 2;
      continue;
    }

    if (c === "'") {
      const close = input.indexOf("'", i + 1);
      if (close === -1) throw new ShellSyntaxError('unterminated single quote');
      value += input.slice(i + 1, close);
      i = close + 1;
      continue;
    }

    if (c === '$' && input[i + 1] === "'") {
      // ANSI-C quoting $'...': treat escapes loosely.
      const close = findAnsiCClose(input, i + 2);
      value += decodeAnsiC(input.slice(i + 2, close));
      i = close + 1;
      continue;
    }

    if (c === '"') {
      i++;
      while (i < n && input[i] !== '"') {
        const d = input[i]!;
        if (d === '\\' && i + 1 < n && '$`"\\\n'.includes(input[i + 1]!)) {
          if (input[i + 1] !== '\n') value += input[i + 1];
          i += 2;
          continue;
        }
        if (d === '$' || d === '`') {
          const exp = readExpansion(input, i);
          value += exp.text;
          if (exp.dynamic) dynamic = true;
          if (exp.substitution !== undefined) substitutions.push(exp.substitution);
          i = exp.end;
          continue;
        }
        value += d;
        i++;
      }
      if (i >= n) throw new ShellSyntaxError('unterminated double quote');
      i++; // closing quote
      continue;
    }

    if (c === '$' || c === '`') {
      const exp = readExpansion(input, i);
      value += exp.text;
      if (exp.dynamic) dynamic = true;
      if (exp.substitution !== undefined) substitutions.push(exp.substitution);
      i = exp.end;
      continue;
    }

    value += c;
    i++;
  }

  return { token: { type: 'word', value, start, end: i, dynamic, substitutions }, end: i };
}

interface Expansion {
  text: string;
  end: number;
  dynamic: boolean;
  substitution?: string;
}

function readExpansion(input: string, i: number): Expansion {
  const n = input.length;
  if (input[i] === '`') {
    let j = i + 1;
    while (j < n && input[j] !== '`') {
      if (input[j] === '\\') j++;
      j++;
    }
    if (j >= n) throw new ShellSyntaxError('unterminated backtick');
    const body = input.slice(i + 1, j);
    return { text: input.slice(i, j + 1), end: j + 1, dynamic: true, substitution: body };
  }
  // input[i] === '$'
  const next = input[i + 1];
  if (next === '(') {
    const arithmetic = input[i + 2] === '(';
    const close = findMatchingParen(input, i + 1);
    const body = input.slice(i + 2, close);
    return {
      text: input.slice(i, close + 1),
      end: close + 1,
      dynamic: true,
      substitution: arithmetic ? undefined : body,
    };
  }
  if (next === '{') {
    const close = input.indexOf('}', i + 2);
    if (close === -1) throw new ShellSyntaxError('unterminated ${');
    return { text: input.slice(i, close + 1), end: close + 1, dynamic: true };
  }
  if (next !== undefined && /[A-Za-z0-9_@*#?$!-]/.test(next)) {
    let j = i + 1;
    if (/[A-Za-z_]/.test(next)) {
      while (j < n && /[A-Za-z0-9_]/.test(input[j]!)) j++;
    } else {
      j++;
    }
    return { text: input.slice(i, j), end: j, dynamic: true };
  }
  // A lone '$' is literal.
  return { text: '$', end: i + 1, dynamic: false };
}

function findMatchingParen(input: string, open: number): number {
  let depth = 0;
  let i = open;
  const n = input.length;
  while (i < n) {
    const c = input[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'") {
      const close = input.indexOf("'", i + 1);
      if (close === -1) throw new ShellSyntaxError('unterminated single quote');
      i = close + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && input[i] !== '"') {
        if (input[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  throw new ShellSyntaxError('unterminated $(');
}

function findAnsiCClose(input: string, i: number): number {
  while (i < input.length && input[i] !== "'") {
    if (input[i] === '\\') i++;
    i++;
  }
  if (i >= input.length) throw new ShellSyntaxError("unterminated $'");
  return i;
}

function decodeAnsiC(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_, e: string) => {
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return ({ n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' } as Record<string, string>)[e] ?? e;
  });
}
