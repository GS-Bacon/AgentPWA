import type { EffortLevel, FileChange, PermissionMode, DriverEvent } from '@agentpwa/shared';
import { rateSnapshots } from './auth.ts';
import type { Wire } from './rpc.ts';

export function permissions(mode: PermissionMode, cwd: string) {
  if (mode === 'full_auto') return {
    approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access',
    sandboxPolicy: { type: 'dangerFullAccess' },
  };
  if (mode === 'plan' || mode === 'ask') return {
    approvalPolicy: mode === 'plan' ? 'never' : 'untrusted', approvalsReviewer: 'user', sandbox: 'read-only',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
  };
  return {
    approvalPolicy: 'on-request',
    approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user', sandbox: 'workspace-write',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  };
}

export function isEffort(value: unknown): value is EffortLevel {
  return typeof value === 'string' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(value);
}

export function fileChanges(item: Wire): FileChange[] {
  return (item.changes ?? []).map((change: Wire) => {
    const type = change.kind?.type;
    let diff = String(change.diff ?? '');
    // add / delete の diff は、この版では unified diff ではなくファイル全体が届く。
    if (type === 'add' || type === 'delete') {
      const lines = diff ? diff.replace(/\n$/, '').split('\n') : [];
      const count = lines.length;
      const prefix = type === 'add' ? '+' : '-';
      diff = `--- ${type === 'add' ? '/dev/null' : `a/${change.path}`}\n+++ ${type === 'delete' ? '/dev/null' : `b/${change.path}`}\n@@ -${type === 'add' ? '0,0' : `1,${count}`} +${type === 'delete' ? '0,0' : `1,${count}`} @@\n` + lines.map((line: string) => prefix + line).join('\n') + (count ? '\n' : '');
    }
    let additions = 0, deletions = 0;
    let inHunk = false;
    for (const line of diff.split(/\r?\n/)) {
      if (line.startsWith('@@ ')) inHunk = true;
      if (line.startsWith('+') && (inHunk || !line.startsWith('+++ '))) additions++;
      if (line.startsWith('-') && (inHunk || !line.startsWith('--- '))) deletions++;
    }
    return {
      path: String(change.path),
      kind: type === 'add' ? 'add' : type === 'delete' ? 'delete' : change.kind?.move_path ? 'rename' : 'modify',
      additions, deletions, diff,
    };
  });
}

export function toolEvent(item: Wire, done: boolean): DriverEvent | undefined {
  const failed = ['failed', 'declined', 'cancelled'].includes(item.status) || item.success === false;
  const base = { type: 'tool' as const, toolId: String(item.id), state: !done ? 'running' as const : failed ? 'failed' as const : 'done' as const };
  if (item.type === 'fileChange') {
    const changes = fileChanges(item);
    const changesOnWire: Wire[] = item.changes ?? [];
    const paths = [...new Set(changesOnWire.flatMap((c) => [c.path, c.kind?.move_path].filter((p): p is string => typeof p === 'string')))];
    return { ...base, name: 'apply_patch', summary: changes.map((c) => `${c.path} +${c.additions} −${c.deletions}`).join(', '), paths, output: done ? changes.map((c) => c.diff).join('\n') : undefined };
  }
  if (item.type === 'commandExecution') return {
    ...base, name: 'commandExecution', summary: String(item.command), output: item.aggregatedOutput ?? undefined,
    paths: (item.commandActions ?? []).filter((a: Wire) => a.type === 'read' && typeof a.path === 'string').map((a: Wire) => a.path),
  };
  if (item.type === 'imageView') return { ...base, name: 'imageView', summary: item.path, paths: [item.path] };
  if (['mcpToolCall', 'dynamicToolCall', 'webSearch', 'collabAgentToolCall', 'contextCompaction', 'imageGeneration'].includes(item.type)) {
    return { ...base, name: item.tool ?? item.type, summary: item.tool ?? item.type };
  }
}

export function emitUsage(result: Wire, emit: (event: DriverEvent) => void) {
  for (const snapshot of rateSnapshots(result)) {
    for (const [key, suffix] of [['primary', '短期枠'], ['secondary', '長期枠']]) {
      const window = snapshot[key];
      if (!window || !Number.isFinite(window.usedPercent)) continue;
      const minutes = window.windowDurationMins;
      const label = minutes === 10080 ? '週間枠' : minutes === 300 ? '5時間枠' : typeof minutes === 'number' && minutes > 0 ? `${minutes}分枠` : suffix;
      emit({ type: 'usage', label: `${snapshot.limitName ?? snapshot.limitId ?? 'Codex'} ${label}`,
        percent: window.usedPercent, windowMinutes: typeof minutes === 'number' ? minutes : undefined,
        resetsAt: typeof window.resetsAt === 'number' ? new Date(window.resetsAt * 1000).toISOString() : undefined });
    }
  }
}
