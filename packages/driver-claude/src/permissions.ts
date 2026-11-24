// Claude のツール呼び出しを、プロトコルの表示用データ（要約・許可要求・質問）に変換する。
import type { ApprovalDecision, DriverEvent, FileChange, PermissionMode, QuestionItem, QuestionOption } from '@agentpwa/shared';

type Input = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** プロトコルの権限モードを `claude --permission-mode` の値に対応付ける。 */
export function toClaudePermissionMode(mode: PermissionMode): string {
  switch (mode) {
    case 'auto_edit':
      return 'acceptEdits';
    case 'auto':
      return 'auto';
    case 'full_auto':
      return 'bypassPermissions';
    case 'plan':
      return 'plan';
    case 'ask':
    default:
      return 'default';
  }
}

/** `claude` の権限モード（system/init・system/status の permissionMode）をプロトコルの値に戻す。知らない値は undefined。 */
export function fromClaudePermissionMode(mode: unknown): PermissionMode | undefined {
  switch (mode) {
    case 'default':
      return 'ask';
    case 'acceptEdits':
      return 'auto_edit';
    case 'auto':
      return 'auto';
    case 'bypassPermissions':
      return 'full_auto';
    case 'plan':
      return 'plan';
    default:
      return undefined;
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

/** ファイルを対象にするツールの、対象ファイルのパス（ファイルビュワー用）。無ければ undefined。 */
export function toolPaths(name: string, input: Input): string[] | undefined {
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const p = str(input.file_path || input.notebook_path);
      return p ? [p] : undefined;
    }
    default:
      return undefined;
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
    const questions = toQuestionItems(input);
    const prompt = questions.map((q) => q.question).join('\n');
    const options = questions.length === 1 ? questions[0].options.map((o) => o.label) : undefined;
    return { kind: 'question', event: { type: 'question', requestId, prompt, options, questions } };
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

/** AskUserQuestion の input.questions を、プロトコルの QuestionItem に直す（質問文の無いものは捨てる）。 */
function toQuestionItems(input: Input): QuestionItem[] {
  const qs = Array.isArray(input.questions) ? (input.questions as Input[]) : [];
  const out: QuestionItem[] = [];
  for (const q of qs) {
    const question = str(q.question);
    if (!question) continue;
    const opts = Array.isArray(q.options) ? (q.options as Input[]) : [];
    const options: QuestionOption[] = [];
    for (const o of opts) {
      const label = str(o.label);
      if (!label) continue;
      const description = str(o.description);
      options.push(description ? { label, description } : { label });
    }
    const item: QuestionItem = { question, options };
    if (str(q.header)) item.header = str(q.header);
    if (q.multiSelect === true) item.multiSelect = true;
    out.push(item);
  }
  return out;
}

/**
 * AskUserQuestion への回答を、claude CLI が受け付ける updatedInput に変換する。
 * perQuestion（問いごとの回答。順番は buildPrompt の questions と同じ）があればそれを使い、
 * 無ければ（古い Web から）text をすべての問いの答えにする。
 */
export function answerToUpdatedInput(input: Input, text: string, perQuestion?: string[]): Input {
  const answers: Record<string, string> = {};
  toQuestionItems(input).forEach((q, i) => {
    answers[q.question] = perQuestion ? (perQuestion[i] ?? '').trim() || '（回答なし）' : text;
  });
  return { ...input, answers };
}
