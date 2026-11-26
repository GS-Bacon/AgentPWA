// Markdown の表示。インラインコードのうち、ファイルのパスに見えるもの（`slides/index.html` など）は、
// タップするとファイルビュワーで開く（docs/architecture.md の 5.1）。会話の返答とビュワーの Markdown で共通に使う。
// リンク（[名前](G:\a\b.html) など）も、リンク先が手元のファイルならビュワーで開く。
// ふつうの <a href> にすると、ドライブ文字のパスは安全でない URL として href が空になり、押すとページが読み直されてしまう。
// コードブロックには右上にコピーボタンを付ける。
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { IconCheck, IconCopy } from './Icons.tsx';
import { linkToFilePath, looksLikePath, openFile, stripLineNo } from '../lib/viewer.ts';

/** 手元のファイルへのリンクは、そのまま残す（既定の変換はドライブ文字のパスを空にしてしまう） */
const urlTransform = (url: string) => (linkToFilePath(url) !== null ? url : defaultUrlTransform(url));

export const PathMarkdown = memo(function PathMarkdown({ text, sessionId, className = 'msg-assistant' }: { text: string; sessionId: string; className?: string }) {
  const components = useMemo(
    () => ({
      a({ href, children, ...rest }: React.ComponentProps<'a'> & { node?: unknown }) {
        const { node: _n, ...props } = rest;
        const file = linkToFilePath(href);
        if (file !== null) {
          return (
            <button type="button" className="path-link" title={`ビュワーで開く: ${file}`} onClick={() => openFile(sessionId, file)}>
              {children}
            </button>
          );
        }
        // ページ内の見出し（#...）はそのまま。外のページは別のタブで開く（アプリの画面を置き換えない）
        if (!href || href.startsWith('#')) return <a href={href} {...props}>{children}</a>;
        return <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>;
      },
      pre({ children, ...rest }: React.ComponentProps<'pre'> & { node?: unknown }) {
        const { node: _n, ...props } = rest;
        return <CodeBlock {...props}>{children}</CodeBlock>;
      },
      code({ className: cls, children, ...rest }: React.ComponentProps<'code'> & { node?: unknown }) {
        const { node: _n, ...props } = rest;
        const raw = typeof children === 'string' ? children : Array.isArray(children) && children.every((c) => typeof c === 'string') ? children.join('') : null;
        // コードブロック（言語の指定や改行がある）はそのまま
        if (cls || raw === null || raw.includes('\n') || !looksLikePath(raw)) return <code className={cls} {...props}>{children}</code>;
        return (
          <code {...props}>
            <button className="path-link" title="ビュワーで開く" onClick={() => openFile(sessionId, stripLineNo(raw))}>
              {raw}
            </button>
          </code>
        );
      },
    }),
    [sessionId],
  );
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>{text}</ReactMarkdown>
    </div>
  );
});

/** クリップボードへ書き込む。http で開いたとき（安全でない文脈）は navigator.clipboard が使えないので、古い方法で書き込む */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 下の方法を試す
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/** コードブロック（pre）。右上のボタンで中身をクリップボードにコピーする */
function CodeBlock({ children, ...props }: React.ComponentProps<'pre'>) {
  const preRef = useRef<HTMLPreElement>(null);
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 1500);
    return () => clearTimeout(t);
  }, [state]);
  const onCopy = async () => {
    // Markdown のコードブロックは末尾に改行が 1 つ付くので取り除く
    const text = (preRef.current?.textContent ?? '').replace(/\n$/, '');
    setState((await copyText(text)) ? 'copied' : 'failed');
  };
  const label = state === 'copied' ? 'コピーしました' : state === 'failed' ? 'コピーできませんでした' : 'コピー';
  return (
    <div className="code-block">
      <pre ref={preRef} {...props}>{children}</pre>
      <button type="button" className={`code-copy${state === 'copied' ? ' copied' : ''}`} title={label} aria-label={label} onClick={onCopy}>
        {state === 'copied' ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </button>
    </div>
  );
}
