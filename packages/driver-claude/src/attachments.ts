// 添付ファイル（v7）を claude CLI への入力に変える。
//
// - 画像（PNG / JPEG / GIF / WebP）は、そのまま画像のブロックとして渡す（デスクトップアプリで画像を貼ったときと同じ）。
// - それ以外（と、API の上限を超える大きな画像）は、セッションごとのフォルダに保存し、パスを本文に書き足す。
//   フォルダは CLI の起動時に --add-dir で渡すので、Claude は確認なしで Read ツールで読める。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Attachment, AttachmentInfo } from '@agentpwa/shared';

/** 画像のブロックとして渡せる種類（Claude API が受け付けるもの） */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** 画像のブロックで渡す上限（API の上限 5MB は base64 の大きさなので、元のバイト数ではその 3/4） */
const MAX_INLINE_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);

export interface AttachmentStore {
  /** セッションの添付ファイルを置くフォルダ（CLI の --add-dir に渡す）。無ければ作る */
  dir(sessionId: string): string;
  /** ファイルを保存し、CLI から見えるパスを返す */
  save(sessionId: string, name: string, data: Buffer): string;
}

/** ファイル名に使えない文字を置き換え、フォルダの部分を落とす */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
  return cleaned.slice(-120) || 'file';
}

/** このPCの一時フォルダに保存する（local の起動役のとき）。 */
export function createLocalAttachmentStore(root = path.join(os.tmpdir(), 'agentpwa-attachments')): AttachmentStore {
  const dir = (sessionId: string) => {
    const d = path.join(root, sessionId.replace(/[^A-Za-z0-9-]/g, '_'));
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  return {
    dir,
    save(sessionId, name, data) {
      const d = dir(sessionId);
      // 同じ名前を何度添付しても上書きしないよう、時刻を前に付ける
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
      const p = path.join(d, `${stamp}-${safeFileName(name)}`);
      fs.writeFileSync(p, data);
      return p;
    },
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface UserContent {
  /** stream-json の user メッセージの content（添付が無ければ文字列のまま） */
  content: string | Json[];
  /** 会話の記録に残す添付ファイルの情報 */
  infos: AttachmentInfo[];
}

/**
 * 本文と添付ファイルから、CLI に渡す user メッセージの content を作る。
 * 画像以外を保存できない（store が無い）ときは例外を投げる。
 */
export function buildUserContent(sessionId: string, text: string, attachments: Attachment[] | undefined, store: AttachmentStore | undefined): UserContent {
  if (!attachments || attachments.length === 0) return { content: text, infos: [] };
  const images: Json[] = [];
  const saved: string[] = [];
  const infos: AttachmentInfo[] = [];
  for (const a of attachments) {
    const data = Buffer.from(a.data, 'base64');
    const mimeType = a.mimeType.toLowerCase();
    infos.push({ name: a.name, mimeType, size: data.length });
    if (IMAGE_TYPES.has(mimeType) && data.length <= MAX_INLINE_IMAGE_BYTES) {
      images.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: a.data } });
      continue;
    }
    if (!store) throw new Error(`このマシンでは画像以外のファイルを添付できません: ${a.name}`);
    saved.push(store.save(sessionId, a.name, data));
  }
  let body = text;
  if (saved.length > 0) {
    const list = saved.map((p) => `- ${p}`).join('\n');
    body = `${text.trim() ? `${text}\n\n` : ''}添付ファイル（Read ツールで読めます）:\n${list}`;
  }
  const content: Json[] = [...images];
  if (body.trim()) content.push({ type: 'text', text: body });
  return { content, infos };
}
