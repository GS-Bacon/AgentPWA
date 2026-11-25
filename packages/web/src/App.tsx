// 画面幅で iPhone 用（タブと1画面ずつの遷移）と iPad / Web 用（複数ペイン）を切り替える。
import { useEffect, useState } from 'react';
import { useStore } from './lib/store.ts';
import { PhoneApp } from './phone/PhoneApp.tsx';
import { DesktopApp } from './desktop/DesktopApp.tsx';
import { ConfirmHost, Toast } from './components/common.tsx';

const PHONE_MAX = 700;
/** 一覧の末尾の「アーカイブ済み」を開いているか（端末ごとに覚える） */
const ARCHIVE_OPEN_KEY = 'agentpwa.archivedOpen';

function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => window.innerWidth < PHONE_MAX);
  useEffect(() => {
    const on = () => setPhone(window.innerWidth < PHONE_MAX);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return phone;
}

/**
 * 接続中の画面。つながらない理由が「許可されていない」（401 / 403）なら、それと次にやることを出す。
 * PWA は画面をキャッシュから出すので、Hub の 403 ページは見えない。そのため Web の側でも /api/info を確かめる。
 * 許可されるとつながる（WebSocket の再接続で ready になる）。
 */
function Connecting() {
  const [denied, setDenied] = useState<{ status: number; reason: string } | null>(null);
  useEffect(() => {
    let stop = false;
    const check = async () => {
      try {
        const res = await fetch('/api/info', { cache: 'no-store', credentials: 'same-origin' });
        if (stop) return;
        if (res.status === 401 || res.status === 403) setDenied({ status: res.status, reason: await res.text() });
        else setDenied(null);
      } catch {
        /* Hub が止まっているなど。接続中の表示のまま */
      }
    };
    const first = setTimeout(check, 1000);
    const timer = setInterval(check, 5000);
    return () => {
      stop = true;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);
  if (!denied) {
    return (
      <div className="empty" style={{ height: '100%', justifyContent: 'center' }}>
        <span>Hub に接続しています…</span>
      </div>
    );
  }
  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '32px 20px' }}>
      <div style={{ maxWidth: 520, margin: '0 auto', lineHeight: 1.7 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 16px' }}>AgentPWA を開けません</h1>
        {denied.status === 403 ? (
          <>
            <p>{denied.reason}。</p>
            <p>
              この Hub を動かしている PC で、すでに許可されている端末から AgentPWA を開くか、その PC のブラウザで <span className="mono">http://127.0.0.1:8787/</span> を開き、<b>設定 → アクセス</b> の「許可待ち」から許可してください。許可されると、この画面は自動で開きます。
            </p>
          </>
        ) : (
          <>
            <p>{denied.reason}</p>
            <p>
              Tailscale の <span className="mono">tailscale serve</span> で公開した URL（<span className="mono">https://&lt;PC名&gt;.&lt;tailnet名&gt;.ts.net/</span>）から開いてください。この端末が tailnet に入っている必要があります。
            </p>
          </>
        )}
        <p className="muted" style={{ fontSize: 13 }}>確認を続けています…</p>
      </div>
    </div>
  );
}

export interface ArchiveSectionProps {
  archivedOpen: boolean;
  setArchivedOpen: (v: boolean) => void;
}

export function App() {
  const phone = useIsPhone();
  const ready = useStore((s) => s.ready);
  const [archivedOpen, setOpenState] = useState(() => {
    try {
      return localStorage.getItem(ARCHIVE_OPEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setArchivedOpen = (v: boolean) => {
    setOpenState(v);
    try {
      localStorage.setItem(ARCHIVE_OPEN_KEY, v ? '1' : '0');
    } catch {
      /* noop */
    }
  };
  if (!ready) return <Connecting />;
  return (
    <>
      {phone ? <PhoneApp archivedOpen={archivedOpen} setArchivedOpen={setArchivedOpen} /> : <DesktopApp archivedOpen={archivedOpen} setArchivedOpen={setArchivedOpen} />}
      <Toast />
      <ConfirmHost />
    </>
  );
}
