// セッションのアーカイブ・削除・権限モードの切り替え（全端末で共通の操作）。
import type { PermissionMode } from '@agentpwa/shared';
import type { SessionSummary } from '@agentpwa/hub/api';
import { api } from './api.ts';
import { askConfirm, getState, run, showToast, showUndo } from './store.ts';
import { MODE_LABEL } from './format.ts';

/** 実行中・許可待ち・質問待ち（アーカイブ・削除の前に Hub がエージェントを止める） */
export function isActive(s: SessionSummary): boolean {
  return s.status === 'starting' || s.status === 'running' || s.status === 'waiting_approval' || s.status === 'waiting_input';
}

/** アーカイブする。確認は挟まず、画面下に「元に戻す」を数秒出す */
export async function archiveSession(id: string): Promise<void> {
  const s = await run(() => api.update(id, { archived: true }));
  if (!s) return;
  showUndo(`「${s.title}」をアーカイブしました`, () => void unarchiveSession(id));
}

/** アーカイブを解除する（セッションは止まったまま。送信すると続きから再開する） */
export async function unarchiveSession(id: string): Promise<void> {
  await run(() => api.update(id, { archived: false }));
}

/** ピン止めする・外す（ピン止めしたセッションは一覧の先頭に出る。全端末で共有） */
export async function setPinned(id: string, pinned: boolean): Promise<void> {
  await run(() => api.update(id, { pinned }));
}

/** 未読にする・既読にする（未読の印は、そのセッションを開くと外れる） */
export async function setUnread(id: string, unread: boolean): Promise<void> {
  await run(() => api.update(id, { unread }));
}

/** 削除する。元に戻せないので確認を1回挟む */
export async function deleteSession(id: string): Promise<void> {
  const s = getState().sessions[id];
  if (!s) return;
  const body = ['このセッションを削除します。元に戻せません'];
  if (isActive(s)) body.push('実行中のセッションを止めます');
  const ok = await askConfirm({ title: `「${s.title}」を削除`, body, confirmLabel: '削除', danger: true });
  if (!ok) return;
  const r = await run(() => api.remove(id));
  if (r?.historyError) showToast(`Hub の記録は削除しましたが、エージェント側の履歴を消せませんでした: ${r.historyError}`);
}

/** 「すべて自動」を選ぶときの確認（1回だけ挟む） */
export function confirmFullAuto(): Promise<boolean> {
  return askConfirm({
    title: `「${MODE_LABEL.full_auto}」にする`,
    body: ['すべての操作（コマンドの実行・ファイルの変更）を確認せずに実行します。', 'よろしいですか？'],
    confirmLabel: '「すべて自動」にする',
  });
}

/**
 * 権限モードの切り替えを Hub に頼む。反映されると Driver の permission_mode で表示が変わる。
 * 反映できなかったときは Driver の error がペインに出て、モードは元のまま。
 */
export async function requestPermissionMode(id: string, mode: PermissionMode): Promise<boolean> {
  const r = await run(() => api.action(id, { type: 'set_permission_mode', mode }));
  return Boolean(r);
}
