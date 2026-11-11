import { statSync } from 'node:fs';
import path from 'node:path';
import { AweError } from './errors.js';

// Splits a command string from awe.json into argv. Quote-aware, but it never involves a shell:
// the tokens are used as-is, so nothing inside a prompt can be interpreted as shell syntax.
//   'single quotes'  literal
//   "double quotes"  literal, except \" and \\
//   outside quotes   \<space>, \", \', \\ escape the next character; any other backslash is literal
//                    (so Windows paths such as C:\tools\agent.exe need no escaping)
export function splitCommand(text, where = 'command') {
  if (typeof text !== 'string') throw new AweError('INVALID_CONFIG', `${where} must be a string such as "claude -p {prompt}"`);
  const tokens = [];
  let current = '';
  let started = false;
  let quote = null;
  const flush = () => {
    if (started) tokens.push(current);
    current = '';
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (quote === "'") {
      if (char === "'") quote = null; else current += char;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '\\' && (next === '"' || next === '\\')) { current += next; i++; }
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      flush();
    } else if (char === '\\' && next !== undefined && (/\s/.test(next) || '"\'\\'.includes(next))) {
      current += next;
      started = true;
      i++;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new AweError('INVALID_CONFIG', `${where} has an unclosed ${quote} quote: ${text}`);
  flush();
  if (!tokens.length) throw new AweError('INVALID_CONFIG', `${where} is empty. Expected a command such as "claude -p {prompt}"`);
  return tokens;
}

export const PLACEHOLDER = /\{prompt_file\}|\{prompt\}/g;

export const usesPlaceholder = argv => argv.some(token => /\{prompt_file\}|\{prompt\}/.test(token));

// Tokens that are plain option names, short sub-commands or very short values (-p, --skip-git-repo-check,
// exec, run, 0)
// carry no secret. Anything else (a payload, a key, a model name) is treated as private: it is
// redacted from error text and hidden when the command is shown.
export const isPlainToken = token => token.length <= 3 || /^-{1,2}[A-Za-z][\w-]*$/.test(token) || /^[a-z]{1,5}$/.test(token);

// A path that names an existing file inside the workflow (the agent script of `node agent.cjs`) is not a
// credential, and it is what tells two commands apart.
const workflowFile = (token, root) => {
  if (!root) return false;
  try {
    const absolute = path.resolve(root, token);
    const relative = path.relative(root, absolute);
    return !relative.startsWith('..') && !path.isAbsolute(relative) && statSync(absolute).isFile();
  } catch {
    return false;
  }
};

// Shown back to people (run header, awe check). The executable, plain tokens and files inside the
// workflow are shown; other arguments become "…" so credentials passed on the command line never
// reach the terminal or logs.
export const displayCommand = (argv, root) => argv.map((token, index) => {
  if (index === 0 || isPlainToken(token) || /^(\{prompt\}|\{prompt_file\})$/.test(token) || workflowFile(token, root)) return token;
  return '…';
}).join(' ');

// The literal command, quoted, for turning a legacy config into the new one.
export const fullCommand = argv => argv.map(token => (/[\s"'\\]/.test(token) || token === '' ? JSON.stringify(token) : token)).join(' ');
