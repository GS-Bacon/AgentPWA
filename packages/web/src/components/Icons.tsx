// 線のアイコン（装飾なので aria-hidden）
import type { ReactNode } from 'react';
import type { ProjectColor } from '@agentpwa/hub/api';
import { PROJECT_COLOR_HEX } from '../lib/format.ts';

function Svg({ size = 16, children, fill = false, sw = 2 }: { size?: number; children: ReactNode; fill?: boolean; sw?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? 'currentColor' : 'none'}
      stroke={fill ? 'none' : 'currentColor'}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconPlus = (p: { size?: number }) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
export const IconClose = (p: { size?: number }) => <Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>;
export const IconChat = (p: { size?: number }) => <Svg {...p}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" /></Svg>;
export const IconCode = (p: { size?: number }) => <Svg {...p}><path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" /></Svg>;
export const IconGear = (p: { size?: number }) => (
  <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></Svg>
);
export const IconBack = (p: { size?: number }) => <Svg {...p}><path d="M15 18l-6-6 6-6" /></Svg>;
export const IconMore = (p: { size?: number }) => (
  <Svg {...p} fill><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></Svg>
);
export const IconSend = (p: { size?: number }) => <Svg {...p} sw={2.2}><path d="M12 19V5M5 12l7-7 7 7" /></Svg>;
export const IconPaperclip = (p: { size?: number }) => (
  <Svg {...p}><path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" /></Svg>
);
export const IconFile = (p: { size?: number }) => <Svg {...p}><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5" /></Svg>;
export const IconChevron = (p: { size?: number }) => <Svg {...p}><path d="M9 6l6 6-6 6" /></Svg>;
export const IconStop = (p: { size?: number }) => <Svg {...p} fill><rect x="6" y="6" width="12" height="12" /></Svg>;
export const IconMaximize = (p: { size?: number }) => <Svg {...p}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Svg>;
export const IconCopy = (p: { size?: number }) => (
  <Svg {...p}><rect x="9" y="9" width="12" height="12" rx="1" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></Svg>
);
export const IconCheck = (p: { size?: number }) => <Svg {...p}><path d="M5 12l5 5 9-10" /></Svg>;
/** フォーク（枝分かれ） */
export const IconFork = (p: { size?: number }) => (
  <Svg {...p}><circle cx="6" cy="5" r="2" /><circle cx="18" cy="5" r="2" /><circle cx="12" cy="19" r="2" /><path d="M6 7v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7M12 12v5" /></Svg>
);
/** 巻き戻し（左回りの矢印） */
export const IconRewind = (p: { size?: number }) => <Svg {...p}><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" /></Svg>;
/** 編集（鉛筆） */
export const IconPencil = (p: { size?: number }) => <Svg {...p}><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" /></Svg>;
export const IconSidebar = (p: { size?: number }) => <Svg {...p}><rect x="3" y="4" width="18" height="16" /><path d="M9 4v16" /></Svg>;
/** ピン止め（画鋲） */
export const IconPin = (p: { size?: number }) => <Svg {...p}><path d="M9 4h6M10 4v6l-3 4h10l-3-4V4M12 14v7" /></Svg>;


/** AI のアイコン（Claude は橙の吹き出し、Codex は青の </>）。プロジェクトの既定の AI や、セッションの AI を示す */
export function AgentIcon({ agent, size = 14 }: { agent: 'claude' | 'codex'; size?: number }) {
  const color = agent === 'claude' ? 'var(--claude)' : 'var(--codex)';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={agent === 'claude' ? 'Claude' : 'Codex'}
      style={{ flex: 'none', verticalAlign: '-2px' }}
    >
      {agent === 'claude' ? <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" /> : <path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" />}
    </svg>
  );
}

/** プロジェクトの色の見本（一覧のプロジェクト名の横）。色が無ければ何も出さない */
export function ProjectSwatch({ color, size = 10 }: { color?: ProjectColor; size?: number }) {
  if (!color) return null;
  return <span aria-hidden="true" style={{ width: size, height: size, flex: 'none', display: 'inline-block', background: PROJECT_COLOR_HEX[color] }} />;
}
