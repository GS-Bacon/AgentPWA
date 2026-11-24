// Claude のツール呼び出しを、プロトコルの表示用データ（要約・許可要求・質問）に変換する。
import type { ApprovalDecision, DriverEvent, FileChange, PermissionMode } from '@agentpwa/shared';

type Input = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** プロトコルの権限モードを `claude --permission-mode` の値に対応付ける。 */
export function toClaudePermissionMode(mode: PermissionMode): string {
  switch (mode) {
    case 'auto_edit':
      return 'acceptEdits';
    case 'plan':
      return 'plan';
    case 'ask':
    default:
      return 'default';
  }
}

function lineCount(s: string): number {
  if (!s) return 0;
  return s.split('\n').length;
}

/** ツール呼び出しの一行要約（一覧やペインに出す）。 */
export function summarizeTool(name: string, input: Input): string {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return str(input.command).split('\n')[0];
    case 'Read':
    case 'NotebookEdit':
      return str(input.file_path || input.notebook_path);
    case 'Write':
      return `${str(input.file_path)} +${lineCount(str(input.content))}`;
    case 'Edit': {
      const add = lineCount(str(input.new_string));
      const del = lineCount(str(input.old_string));
      return `${str(input.file_path)} +${add} −${del}`;
    }
    case 'MultiEdit':
      return str(input.file_path);
    case 'Glob':
      return str(input.pattern);
    case 'Grep':
      return `${str(input.pattern)}${input.path ? ` in ${str(input.path)}` : ''}`;
    case 'WebFetch':
      return str(input.url);
    case 'WebSearch':
      return str(input.query);
    case 'Task':
    case 'Agent':
      return str(input.description);
    case 'TodoWrite':
      return 'TODO を更新';
    case 'AskUserQuestion': {
      const qs = Array.isArray(input.questions) ? (input.questions as Input[]) : [];
      return qs.map((q) => str(q.question)).join(' / ');
    }
    case 'ExitPlanMode':
      return 'プランを提示';
    default: {
      const json = JSON.stringify(input);
      return json.length > 120 ? json.slice(0, 117) + '...' : json;
    }
  }
}

function simpleDiff(path: string, oldText: string, newText: string): string {
  const out = [`--- a/${path}`, `+++ b/${path}`];
  if (oldText) for (const l of oldText.split('\n')) out.push(`-${l}`);
  if (newText) for (const l of newText.split('\n')) out.push(`+${l}`);
  return out.join('\n');
}

const MAX_DIFF = 20_000;

function fileChanges(name: string, input: Input): FileChange[] | undefined {
  const path = str(input.file_path || input.notebook_path);
  if (name === 'Write') {
    const content = str(input.content);
    const diff = simpleDiff(path, '', content);
    return [{ path, kind: 'add', additions: lineCount(content), deletions: 0, diff: diff.length > MAX_DIFF ? undefined : diff }];
  }
  if (name === 'Edit') {
    const o = str(input.old_string);
    const n = str(input.new_string);
    const diff = simpleDiff(path, o, n);
    return [{ path, kind: 'modify', additions: lineCount(n), deletions: lineCount(o), diff: diff.length > MAX_DIFF ? undefined : diff }];
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    let add = 0;
    let del = 0;
    const parts: string[] = [];
    for (const e of input.edits as Input[]) {
      add += lineCount(str(e.new_string));
      del += lineCount(str(e.old_string));
      parts.push(simpleDiff(path, str(e.old_string), str(e.new_string)));
    }
    const diff = parts.join('\n');
    return [{ path, kind: 'modify', additions: add, deletions: del, diff: diff.length > MAX_DIFF ? undefined : diff }];
  }
  if (name === 'NotebookEdit') {
    return [{ path, kind: 'modify' }];
  }
  return undefined;
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/**
 * 「このセッション中は許可」の照合キー。
 * シェルはコマンドの先頭の語（例: npm）ごと、それ以外はツール名ごとに覚える。
 */
export function sessionAllowKey(name: string, input: Input): string {
  if (SHELL_TOOLS.has(name)) {
    const first = str(input.command).trim().split(/\s+/)[0] ?? '';
    return `${name}:${first}`;
  }
  return name;
}

export type PermissionPrompt =
  | { kind: 'approval'; event: Extract<DriverEvent, { type: 'approval_request' }> }
  | { kind: 'question'; event: Extract<DriverEvent, { type: 'question' }> };

/** --permission-prompt-tool に来た問い合わせを、approval_request か question に変換する。 */
export function buildPrompt(requestId: string, name: string, input: Input, cwd: string): PermissionPrompt {
  if (name === 'AskUserQuestion' && Array.isArray(input.questions)) {
    const qs = input.questions as { question?: string; options?: { label?: string }[] }[];
    const prompt = qs.map((q) => str(q.question)).filter(Boolean).join('\n');
    const options = qs.length === 1 ? (qs[0].options ?? []).map((o) => str(o.label)).filter(Boolean) : undefined;
    return { kind: 'question', event: { type: 'question', requestId, prompt, options } };
  }
  const allChoices: ApprovalDecision[] = ['allow', 'allow_session', 'deny'];
  if (SHELL_TOOLS.has(name)) {
    return {
      kind: 'approval',
      event: {
        type: 'approval_request',
        requestId,
        kind: 'command',
        title: 'コマンドの実行許可',
        command: str(input.command),
        cwd,
        choices: allChoices,
      },
    };
  }
  if (FILE_TOOLS.has(name)) {
    return {
      kind: 'approval',
      event: {
        type: 'approval_request',
        requestId,
        kind: 'file_change',
        title: 'ファイル変更の許可',
        cwd,
        changes: fileChanges(name, input),
        choices: allChoices,
      },
    };
  }
  if (name === 'ExitPlanMode') {
    return {
      kind: 'approval',
      event: {
        type: 'approval_request',
        requestId,
        kind: 'other',
        title: 'プランの承認',
        command: str(input.plan),
        choices: ['allow', 'deny'],
      },
    };
  }
  return {
    kind: 'approval',
    event: {
      type: 'approval_request',
      requestId,
      kind: 'permission',
      title: `${name} の使用許可`,
      command: summarizeTool(name, input),
      cwd,
      choices: allChoices,
    },
  };
}

/** AskUserQuestion への回答を、claude CLI が受け付ける updatedInput に変換する。 */
export function answerToUpdatedInput(input: Input, text: string): Input {
  const qs = Array.isArray(input.questions) ? (input.questions as { question?: string }[]) : [];
  const answers: Record<string, string> = {};
  for (const q of qs) if (q.question) answers[q.question] = text;
  return { ...input, answers };
}
