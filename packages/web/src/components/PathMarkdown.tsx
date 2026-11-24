// Markdown の表示。インラインコードのうち、ファイルのパスに見えるもの（`slides/index.html` など）は、
// タップするとファイルビュワーで開く（docs/architecture.md の 5.1）。会話の返答とビュワーの Markdown で共通に使う。
import { memo, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { looksLikePath, openFile, stripLineNo } from '../lib/viewer.ts';

export const PathMarkdown = memo(function PathMarkdown({ text, sessionId, className = 'msg-assistant' }: { text: string; sessionId: string; className?: string }) {
  const components = useMemo(
    () => ({
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
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
    </div>
  );
});
