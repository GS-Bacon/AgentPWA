// 入力欄の添付ファイル: 選んだ・貼り付けた・ドロップしたファイルを、送信用（base64）に変える。
import type { Attachment } from '@agentpwa/shared';

/** 1回の送信で添付できる数と合計の大きさ（Hub の上限と同じ） */
export const MAX_ATTACHMENTS = 10;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/** 画像の長い辺をこの大きさまで縮める（Claude は大きな画像を内部で縮めるので、送る量を減らす） */
const MAX_IMAGE_SIDE = 2000;
/** 画像をそのまま画像として渡せる上限（これを超えると Driver がファイルとして保存する） */
const MAX_IMAGE_BYTES = 3_500_000;
const RESIZABLE = new Set(['image/png', 'image/jpeg', 'image/webp']);

export interface PendingFile {
  id: string;
  file: File;
  /** 画像のときのサムネイル（object URL。外すときに revoke する） */
  preview?: string;
}

let counter = 0;

export function toPending(file: File): PendingFile {
  return { id: `f${Date.now().toString(36)}-${counter++}`, file, preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined };
}

export function releasePending(p: PendingFile): void {
  if (p.preview) URL.revokeObjectURL(p.preview);
}

/** 貼り付けた画像には名前が無い（image.png になる）ので、時刻を付けて区別できるようにする */
export function nameForPasted(file: File): File {
  if (file.name && file.name !== 'image.png' && file.name !== 'image.jpeg') return file;
  const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\..*$/, '');
  return new File([file], `screenshot-${stamp}.${ext}`, { type: file.type });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(r.error ?? new Error('ファイルを読めませんでした'));
    r.readAsDataURL(blob);
  });
}

/** 大きな画像を縮める。縮める必要が無い・縮められないときは元のまま返す */
async function shrinkImage(file: File): Promise<Blob> {
  if (!RESIZABLE.has(file.type)) return file;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return file;
  }
  const side = Math.max(bmp.width, bmp.height);
  if (side <= MAX_IMAGE_SIDE && file.size <= MAX_IMAGE_BYTES) {
    bmp.close();
    return file;
  }
  const scale = Math.min(1, MAX_IMAGE_SIDE / side);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const encode = (type: string, quality?: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  // スクリーンショット（PNG）は文字がつぶれないよう PNG のまま。大きすぎるときだけ JPEG にする
  let out = await encode(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.9);
  if (out && out.size > MAX_IMAGE_BYTES) out = await encode('image/jpeg', 0.85);
  return out && out.size < file.size ? out : file;
}

/** 送信用に変える（画像は必要なら縮める） */
export async function toAttachment(file: File): Promise<Attachment> {
  const blob = file.type.startsWith('image/') ? await shrinkImage(file) : file;
  const mimeType = blob.type || file.type || 'application/octet-stream';
  let name = file.name || 'file';
  // JPEG にしたときは拡張子を合わせる
  if (mimeType === 'image/jpeg' && file.type !== 'image/jpeg') name = name.replace(/\.[^.]+$/, '') + '.jpg';
  return { name, mimeType, data: await blobToBase64(blob) };
}
