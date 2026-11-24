// ファイルビュワー（docs/architecture.md の 5.1）。iPad / Web のペインと、iPhone の全画面で共通に使う。
// HTML はサンドボックス付きの iframe（allow-same-origin なし）で開き、スクリプトも動かす（スライドのページ送りなど）。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileInfo } from '@agentpwa/hub/api';
import { api } from '../lib/api.ts';
import { loadEvents, useStore } from '../lib/store.ts';
import { displayPath, fileUrl, samePath } from '../lib/viewer.ts';
import { IconClose } from './Icons.tsx';
import { PathMarkdown } from './PathMarkdown.tsx';

/** 文字のファイルとして表示する上限 */
const TEXT_LIMIT = 2 * 1024 * 1024;

function sizeLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 先頭から limit バイトまでを文字として読む */
async function readText(url: string, limit: number): Promise<{ text: string; truncated: boolean }> {
  const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || `${res.status}`);
  if (!res.body) return { text: await res.text(), truncated: false };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total >= limit) {
      text += dec.decode(value.subarray(0, value.length - (total - limit)));
      await reader.cancel();
      return { text, truncated: true };
    }
    text += dec.decode(value, { stream: true });
  }
  return { text: text + dec.decode(), truncated: false };
}

function TextBody({ url, markdown, sessionId }: { url: string; markdown: boolean; sessionId: string }) {
  const [data, setData] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState(!markdown);
  useEffect(() => {
    let alive = true;
    readText(url, TEXT_LIMIT).then(
      (d) => alive && setData(d),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [url]);
  const lines = useMemo(() => (data && source ? data.text.split('\n') : []), [data, source]);
  if (error) return <div className="empty">ファイルを開けません: {error}</div>;
  if (!data) return <div className="empty">読み込み中…</div>;
  return (
    <div className="viewer-scroll">
      {markdown && (
        <div className="viewer-toolbar">
          <button className="btn btn-sm" aria-pressed={source} onClick={() => setSource(!source)}>
            {source ? 'プレビュー' : 'ソースを表示'}
          </button>
        </div>
      )}
      {source ? (
        <pre className="viewer-code">
          {lines.map((l, i) => (
            <span key={i} className="viewer-line">
              <span className="viewer-ln" aria-hidden="true">{i + 1}</span>
              {l || ' '}
            </span>
          ))}
        </pre>
      ) : (
        <PathMarkdown text={data.text} sessionId={sessionId} className="msg-assistant viewer-md" />
      )}
      {data.truncated && (
        <div className="empty">
          <span>先頭の {sizeLabel(TEXT_LIMIT)} だけを表示しています</span>
          <a className="btn" href={url} download>全体をダウンロード</a>
        </div>
      )}
    </div>
  );
}

function Body({ sessionId, info, nonce }: { sessionId: string; info: FileInfo; nonce: number }) {
  const url = fileUrl(sessionId, info.path);
  const frame = useRef<HTMLIFrameElement>(null);
  switch (info.kind) {
    case 'html':
      return (
        <iframe
          key={nonce}
          ref={frame}
          className="viewer-frame viewer-frame-html"
          src={url}
          title={info.path}
          // allow-same-origin は付けない（中のスクリプトを別のオリジン扱いにして、Hub の API や PWA の保存データに触れさせない）
          sandbox="allow-scripts allow-popups"
          allow="fullscreen"
          allowFullScreen
          // 開いたらすぐ矢印キーでページ送りできるように、iframe にフォーカスを移す
          onLoad={() => frame.current?.focus()}
        />
      );
    case 'pdf':
      return <iframe key={nonce} className="viewer-frame" src={url} title={info.path} />;
    case 'image':
      return (
        <div className="viewer-scroll viewer-center">
          <img key={nonce} src={`${url}?v=${nonce}`} alt={info.path} style={{ maxWidth: '100%', height: 'auto' }} />
        </div>
      );
    case 'media':
      return (
        <div className="viewer-scroll viewer-center">
          {info.mime.startsWith('audio/') ? (
            <audio key={nonce} src={url} controls />
          ) : (
            <video key={nonce} src={url} controls playsInline style={{ maxWidth: '100%', maxHeight: '100%' }} />
          )}
        </div>
      );
    case 'markdown':
    case 'text':
      return <TextBody key={nonce} url={url} markdown={info.kind === 'markdown'} sessionId={sessionId} />;
    case 'binary':
      return (
        <div className="empty">
          <span>このファイルは表示できません（{sizeLabel(info.size)}）</span>
          <a className="btn" href={url} download>ダウンロード</a>
        </div>
      );
  }
}

type FsElement = HTMLElement & { webkitRequestFullscreen?: () => void };

export function FileViewer({ sessionId, path, lead, trail, onHeadDragStart }: { sessionId: string; path: string; lead?: React.ReactNode; trail?: React.ReactNode; /** ヘッダーをドラッグしてペインを動かす（iPad / Web） */ onHeadDragStart?: (e: React.DragEvent) => void }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const events = useStore((s) => s.events[sessionId]);
  const cwd = session?.cwd ?? '';
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // 読み込んだときの最後のイベント。これより後に同じファイルを変えるツールが終わったら「更新あり」
  const [loadedSeq, setLoadedSeq] = useState(0);
  const [immersive, setImmersive] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const isTouch = useMemo(() => window.matchMedia('(pointer: coarse)').matches, []);

  useEffect(() => {
    void loadEvents(sessionId);
  }, [sessionId]);

  useEffect(() => {
    let alive = true;
    setError(null);
    api.fileInfo(sessionId, path).then(
      (i) => {
        if (!alive) return;
        setInfo(i);
        setLoadedSeq(session?.lastSeq ?? 0);
      },
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, path, nonce]);

  const changed = useMemo(
    () =>
      !!info &&
      (events ?? []).some((e) => e.seq > loadedSeq && e.type === 'tool' && e.state === 'done' && (e.paths ?? []).some((p) => samePath(p, info.path, cwd))),
    [events, info, loadedSeq, cwd],
  );

  const fullscreen = () => {
    const el = box.current as FsElement | null;
    if (!el) return;
    if (el.requestFullscreen && document.fullscreenEnabled) void el.requestFullscreen().catch(() => setImmersive(true));
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    // iPhone の Safari は要素の全画面表示ができないので、画面いっぱいに広げる
    else setImmersive(true);
  };

  const shown = info?.path ?? displayPath(path, cwd);
  const url = info ? fileUrl(sessionId, info.path) : undefined;

  return (
    <div className="viewer" style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <header className="viewer-head" draggable={!!onHeadDragStart} onDragStart={onHeadDragStart}>
        {lead}
        <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <h2 className="ellipsis mono" style={{ fontSize: 12.5, fontWeight: 600 }} title={shown}>{shown}</h2>
          {session && (
            <span className="ellipsis muted" style={{ fontSize: 11 }}>
              {session.folderName}
              {info ? ` · ${sizeLabel(info.size)}` : ''}
            </span>
          )}
        </div>
        <button className="btn btn-ghost btn-icon-sm" aria-label={changed ? '再読み込み（更新あり）' : '再読み込み'} title={changed ? '再読み込み（ファイルが更新されています）' : '再読み込み'} onClick={() => setNonce((n) => n + 1)} style={{ position: 'relative' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
          </svg>
          {changed && <span className="viewer-dot" aria-hidden="true" />}
        </button>
        {info && (info.kind === 'html' || info.kind === 'pdf' || info.kind === 'image' || info.kind === 'media') && (
          <button className="btn btn-ghost btn-icon-sm" aria-label="全画面" title="全画面" onClick={fullscreen}>
            {/* ペインの「最大化」と見分けるため、斜めの矢印にする */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />
            </svg>
          </button>
        )}
        {url && !isTouch && (
          <a className="btn btn-ghost btn-icon-sm" href={url} target="_blank" rel="noopener noreferrer" aria-label="新しいタブで開く" title="新しいタブで開く">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" />
            </svg>
          </a>
        )}
        {trail}
      </header>
      <div ref={box} className={immersive ? 'viewer-body viewer-immersive' : 'viewer-body'}>
        {error ? <div className="empty">ファイルを開けません: {error}</div> : info ? <Body sessionId={sessionId} info={info} nonce={nonce} /> : <div className="empty">読み込み中…</div>}
        {immersive && (
          <button className="btn btn-icon viewer-exit" aria-label="全画面を終了" onClick={() => setImmersive(false)}>
            <IconClose size={18} />
          </button>
        )}
      </div>
    </div>
  );
}
