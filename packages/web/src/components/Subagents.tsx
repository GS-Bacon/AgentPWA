// サブエージェントの表示。ペインの中を上下に分け、下側（サブペイン）にサブエージェントごとのタブを出す。
// ペインの高さが足りないときは会話の中に埋め込み、スマホではサブペインを全面に重ねる。
import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Item, SubagentInfo } from '../lib/transcript.ts';
import { IconBack, IconChevron, IconClose } from './Icons.tsx';
import { PathMarkdown } from './PathMarkdown.tsx';

/** サブペインの出し方。split: ペインを上下に分ける / inline: 会話に埋め込む / full: 全面に重ねる（スマホ） */
export type SubLayout = 'split' | 'inline' | 'full';

/** 会話の項目を描く関数（SessionView の ItemView。循環 import を避けるために渡してもらう） */
type RenderItem = (item: Item) => ReactNode;

interface SubCtxValue {
  sessionId: string;
  subs: Map<string, SubagentInfo>;
  layout: SubLayout;
  /** サブペインでこのサブエージェントを開く */
  select: (toolId: string) => void;
  /** 許可や回答を待っている */
  waiting: (sub: SubagentInfo) => boolean;
  renderItem: RenderItem;
}

export const SubCtx = createContext<SubCtxValue | null>(null);

export function useSubCtx(): SubCtxValue | null {
  return useContext(SubCtx);
}

/** 許可要求（requestId）を出したサブエージェント */
export function subOfRequest(ctx: SubCtxValue | null, requestId: string): SubagentInfo | undefined {
  if (!ctx) return undefined;
  for (const s of ctx.subs.values()) if (s.toolIds.has(requestId)) return s;
  return undefined;
}

export function subLabel(s: SubagentInfo): string {
  return s.agentType ?? 'サブエージェント';
}

function StateMark({ state }: { state: SubagentInfo['state'] }) {
  switch (state) {
    case 'running':
      return <span className="run">…</span>;
    case 'done':
      return <span className="ok">✓</span>;
    case 'failed':
      return <span className="ng">✗</span>;
    default:
      return <span className="muted">■</span>;
  }
}

const STATE_LABEL: Record<SubagentInfo['state'], string> = { running: '作業中', done: '完了', failed: '失敗', stopped: '停止' };

/** 本流の会話で、サブエージェントを起動したところに出す1行 */
export function SubagentLine({ toolId }: { toolId: string }) {
  const ctx = useSubCtx();
  const [open, setOpen] = useState<boolean | null>(null);
  const sub = ctx?.subs.get(toolId);
  if (!ctx || !sub) return null;
  const inline = ctx.layout === 'inline';
  // 埋め込みのときは、動いている間だけ既定で開く
  const expanded = inline && (open ?? sub.state === 'running');
  const waiting = ctx.waiting(sub);
  return (
    <div className="tools">
      <div className="tool-line subagent-line">
        <button
          onClick={() => (inline ? setOpen(!expanded) : ctx.select(toolId))}
          aria-expanded={inline ? expanded : undefined}
          title={inline ? (expanded ? '折りたたむ' : '中身を表示') : 'サブペインで開く'}
        >
          <StateMark state={sub.state} />
          <span className="sub-icon">◆</span>
          <span className="tool-name">{subLabel(sub)}</span>
          <span className="ellipsis">
            {sub.description}
            {sub.state === 'running' && sub.progress ? <span className="faint"> · {sub.progress}</span> : null}
          </span>
          {waiting && <span className="sub-wait">!</span>}
        </button>
      </div>
      {expanded && (
        <StickyScroll className="sub-inline">
          <SubBody sub={sub} />
        </StickyScroll>
      )}
    </div>
  );
}

/** 一番下にいるときは、新しい内容に合わせて下へスクロールし続ける領域 */
function StickyScroll({ className, children }: { className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  return (
    <div
      ref={ref}
      className={className}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {children}
    </div>
  );
}

/** サブエージェントに渡した指示（既定は1行だけ） */
function SubPrompt({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sub-prompt">
      <button onClick={() => setOpen(!open)} aria-expanded={open} title={open ? '折りたたむ' : '全文を表示'}>
        <span className={open ? 'chev open' : 'chev'}>
          <IconChevron size={12} />
        </span>
        <span className="sub-prompt-label">指示</span>
        {!open && <span className="ellipsis">{text.split('\n').find((l) => l.trim()) ?? ''}</span>}
      </button>
      {open && <div className="sub-prompt-text">{text}</div>}
    </div>
  );
}

/** サブエージェントの中身（指示・会話・ツール・結果） */
function SubBody({ sub }: { sub: SubagentInfo }) {
  const ctx = useSubCtx();
  const hasReply = sub.items.some((i) => i.kind === 'assistant');
  return (
    <div className="transcript sub-transcript">
      {sub.prompt && <SubPrompt text={sub.prompt} />}
      {sub.items.map((it) => (
        <Fragment key={it.key}>{ctx?.renderItem(it)}</Fragment>
      ))}
      {/* 会話が届いていない（古い記録など）ときは、報告だけでも出す */}
      {sub.result && !hasReply && ctx && <PathMarkdown text={sub.result} sessionId={ctx.sessionId} />}
      {sub.state === 'running' && <div className="note st-running">● {sub.progress || '作業中…'}</div>}
      {sub.state === 'failed' && <div className="note note-error">失敗しました</div>}
      {sub.state === 'stopped' && <div className="note">— 止まりました</div>}
    </div>
  );
}

const RATIO_KEY = 'agentpwa.subpaneRatio';
const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;

function loadRatio(): number {
  const v = Number(localStorage.getItem(RATIO_KEY));
  return v >= MIN_RATIO && v <= MAX_RATIO ? v : 0.45;
}

export interface SubPaneState {
  /** サブペインを出している */
  visible: boolean;
  /** 開いているタブ（起動したツールの toolId） */
  active: string | null;
  /** 中身を開いている（閉じているときはタブの帯だけ） */
  body: boolean;
}

/**
 * サブペイン（split / full）。タブはサブエージェントごと。
 * split のときは境目をドラッグして高さを変えられ、area（本流とサブペインを含む領域）に対する割合を端末に覚える。
 */
export function SubPane({
  subs,
  ui,
  setUi,
  layout,
  area,
}: {
  subs: SubagentInfo[];
  ui: SubPaneState;
  setUi: (f: (u: SubPaneState) => SubPaneState) => void;
  layout: 'split' | 'full';
  area: React.RefObject<HTMLDivElement | null>;
}) {
  const ctx = useSubCtx();
  const [ratio, setRatio] = useState(loadRatio);
  const [dragging, setDragging] = useState(false);
  const tabsRef = useRef<HTMLDivElement>(null);
  const active = subs.find((s) => s.toolId === ui.active) ?? subs[subs.length - 1];

  // 開いたタブが見えるように横にスクロールする
  useEffect(() => {
    tabsRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active?.toolId]);

  if (!active) return null;
  const full = layout === 'full';

  const onPointerDown = (e: React.PointerEvent) => {
    const el = area.current;
    if (!el) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
    const rect = el.getBoundingClientRect();
    let last = ratio;
    const move = (ev: PointerEvent) => {
      last = Math.min(MAX_RATIO, Math.max(MIN_RATIO, (rect.bottom - ev.clientY) / rect.height));
      setRatio(last);
    };
    const up = () => {
      setDragging(false);
      localStorage.setItem(RATIO_KEY, String(last));
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const style: React.CSSProperties = full ? {} : ui.body ? { flex: `0 0 ${(ratio * 100).toFixed(1)}%` } : { flex: 'none' };

  return (
    <section className={full ? 'subpane subpane-full' : 'subpane'} style={style} aria-label="サブエージェント">
      {!full && ui.body && (
        <div
          className={dragging ? 'subpane-divider dragging' : 'subpane-divider'}
          role="separator"
          aria-orientation="horizontal"
          aria-label="サブペインの高さを変える"
          onPointerDown={onPointerDown}
          onDoubleClick={() => {
            setRatio(0.45);
            localStorage.removeItem(RATIO_KEY);
          }}
        />
      )}
      <div className="subpane-tabs">
        {full && (
          <button className="subpane-tool subpane-back" aria-label="本流に戻る" title="本流に戻る" onClick={() => setUi((u) => ({ ...u, visible: false }))}>
            <IconBack size={16} />
          </button>
        )}
        <div className="subpane-tablist" role="tablist" ref={tabsRef}>
          {subs.map((s) => {
            const selected = s.toolId === active.toolId;
            return (
              <button
                key={s.toolId}
                role="tab"
                aria-selected={selected}
                className={selected ? 'subpane-tab active' : 'subpane-tab'}
                title={`${subLabel(s)}: ${s.description}（${STATE_LABEL[s.state]}）`}
                onClick={() => setUi((u) => ({ ...u, active: s.toolId, body: selected && !full ? !u.body : true }))}
              >
                <StateMark state={s.state} />
                <span className="ellipsis">
                  {subLabel(s)}: {s.description}
                </span>
                {ctx?.waiting(s) && <span className="sub-wait">!</span>}
              </button>
            );
          })}
        </div>
        {!full && (
          <>
            <button
              className="subpane-tool"
              aria-label={ui.body ? 'サブペインを畳む' : 'サブペインを開く'}
              title={ui.body ? '畳む' : '開く'}
              onClick={() => setUi((u) => ({ ...u, body: !u.body }))}
            >
              <span className={ui.body ? 'chev down' : 'chev up'}>
                <IconChevron size={14} />
              </span>
            </button>
            <button className="subpane-tool" aria-label="サブペインを閉じる" title="閉じる" onClick={() => setUi((u) => ({ ...u, visible: false }))}>
              <IconClose size={14} />
            </button>
          </>
        )}
      </div>
      {(ui.body || full) && (
        <StickyScroll key={active.toolId} className="subpane-body">
          <SubBody sub={active} />
        </StickyScroll>
      )}
    </section>
  );
}
