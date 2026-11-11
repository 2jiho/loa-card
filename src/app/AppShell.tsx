import type {ReactNode} from 'react';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import HelpOutline from '@mui/icons-material/HelpOutlined';
import GitHub from '@mui/icons-material/GitHub';
import {UsageGuide} from '../ui/UsageGuide';
import {ThemeToggle} from '../ui/AppTheme';
import {WorkspaceNavigation} from '../ui/WorkspaceNavigation';
import type {WorkspaceView} from '../ui/WorkspaceNavigation';

/** App chrome only: header, navigation, main landmark, footer and usage dialog. */
export function AppShell(props: {
  activeView: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
  onBrandClick: () => void;
  resultsReady: boolean;
  cardCount: number;
  navHint?: string;
  busy: boolean;
  csvReading: boolean;
  engineReady: boolean;
  backupStatus: string;
  catalogVersion: string;
  guideOpen: boolean;
  onGuideOpen: () => void;
  onGuideClose: () => void;
  diagnosticsDisabled: boolean;
  onDiagnostics: () => void;
  children: ReactNode;
}) {
  const {activeView, onViewChange, onBrandClick, resultsReady, cardCount, navHint,
    busy, csvReading, engineReady, backupStatus, catalogVersion, guideOpen,
    onGuideOpen, onGuideClose, diagnosticsDisabled, onDiagnostics, children} = props;
  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href={import.meta.env.BASE_URL} aria-label="LoaCard 메인으로" onClick={event => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onBrandClick();
          window.scrollTo({top: 0, behavior: 'instant'});
        }}><span className="brand-icon" aria-hidden="true">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} width="28" height="30" alt="" />
        </span>LoaCard</a>
        <div className="header-tools"><span className={`local-status ${busy || csvReading ? 'is-active' : ''}`} role="status" title="카드 인식은 현재 브라우저에서 실행됩니다.">
          {busy || csvReading ? <span className="scan-spinner" aria-hidden="true" /> : <span className="status-dot" aria-hidden="true" />}
          {csvReading ? 'CSV 확인 중' : busy ? engineReady ? '브라우저에서 분석 중' : '분석 준비 중' : '로컬 처리'}
        </span><Button color="inherit" startIcon={<HelpOutline />} onClick={() => onGuideOpen()}>사용법</Button>
        <Tooltip title="GitHub 저장소 (새 탭)"><IconButton component="a" href="https://github.com/2jiho/loa-card" target="_blank" rel="noopener noreferrer" aria-label="GitHub 저장소 (새 탭)"><GitHub fontSize="small" /></IconButton></Tooltip><ThemeToggle />
        </div>
      </header>
      <div className="app-layout">
        <WorkspaceNavigation value={activeView} onChange={onViewChange} ready={resultsReady} count={cardCount} hint={navHint} />
        <main className="workspace">{children}</main>
      </div>
      <footer className="app-footer">
        <div>LoaCard · 로스트아크 비공식 팬 도구</div>
        <p className="footer-links"><span>무료·비상업 서비스</span><a href={`${import.meta.env.BASE_URL}licenses/index.html`} target="_blank" rel="noopener noreferrer">라이선스 및 권리 안내</a></p>
        <p>게임 이미지와 데이터의 권리는 스마일게이트 및 각 권리자에게 있습니다.<br />LoaCard는 스마일게이트와 제휴하지 않은 독립적인 서비스입니다.</p>
        <p role="status">{backupStatus}</p>
        {catalogVersion && <p>카드 데이터 기준일: {catalogVersion.replace("client-", "").replaceAll("-", ".")}</p>}
        <p>© 2026 LoaCard</p>
      </footer>
      <UsageGuide open={guideOpen} onClose={onGuideClose} diagnosticsDisabled={diagnosticsDisabled} onDiagnostics={onDiagnostics} />
    </div>
  );
}
