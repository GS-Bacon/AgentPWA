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
  if (!ready) {
    return (
      <div className="empty" style={{ height: '100%', justifyContent: 'center' }}>
        <span>Hub に接続しています…</span>
      </div>
    );
  }
  return (
    <>
      {phone ? <PhoneApp archivedOpen={archivedOpen} setArchivedOpen={setArchivedOpen} /> : <DesktopApp archivedOpen={archivedOpen} setArchivedOpen={setArchivedOpen} />}
      <Toast />
      <ConfirmHost />
    </>
  );
}
