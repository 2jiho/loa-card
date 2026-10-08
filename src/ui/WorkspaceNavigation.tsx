import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import useMediaQuery from '@mui/material/useMediaQuery';
import StyleOutlined from '@mui/icons-material/StyleOutlined';
import StorefrontOutlined from '@mui/icons-material/StorefrontOutlined';
import AutoGraphOutlined from '@mui/icons-material/AutoGraphOutlined';
import ShieldOutlined from '@mui/icons-material/ShieldOutlined';

export type WorkspaceView = 'cards' | 'merchants' | 'growth' | 'raid';
const items = [
  { value: 'cards', label: '내 카드', icon: <StyleOutlined /> },
  { value: 'merchants', label: '떠돌이 상인', icon: <StorefrontOutlined /> },
  { value: 'growth', label: '도감작', icon: <AutoGraphOutlined /> },
  { value: 'raid', label: '레이드 카드', icon: <ShieldOutlined /> },
] as const;

export function WorkspaceNavigation({ value, onChange, ready, count, hint }: {
  value: WorkspaceView; onChange: (value: WorkspaceView) => void; ready: boolean; count: number; hint?: string;
}) {
  const compact = useMediaQuery('(max-width: 900px)');
  return <nav className="workspace-navigation" aria-label="스캔 결과 보기">
    <span className="navigation-caption">카드 관리</span>
    <Tabs value={value} onChange={(_, next: WorkspaceView) => onChange(next)} orientation={compact ? 'horizontal' : 'vertical'}
      variant={compact ? 'fullWidth' : 'standard'} aria-label="결과 화면 선택" selectionFollowsFocus
      sx={{ minHeight: 44, '& .MuiTabs-indicator': { display: 'none' }, '& .MuiTab-root': {
        minHeight: 44, minWidth: 0, justifyContent: 'flex-start', textAlign: 'left', flexDirection: 'row', gap: 1.25,
        px: 1.75, mb: .75, borderRadius: 2, color: 'text.secondary', textTransform: 'none', fontSize: 13,
        '& .MuiSvgIcon-root': { fontSize: 19, margin: 0 },
        '&.Mui-selected': { color: 'primary.main', background: 'var(--accent-soft)' },
        '&.Mui-focusVisible': { outline: '2px solid var(--accent)', outlineOffset: -2 },
        '@media (max-width:900px)': { mb: 0, px: .5, gap: .5, justifyContent: 'center', fontSize: 12 },
        '@media (max-width:480px)': { flexDirection: 'column', gap: .5, py: 1, '& .MuiSvgIcon-root': { fontSize: 18 } },
      } }}>
      {items.map(item => <Tab key={item.value} value={item.value} id={`view-${item.value}`} aria-controls={`panel-${item.value}`}
        disabled={item.value !== 'cards' && !ready} icon={item.icon} iconPosition="start"
        label={<span className="navigation-label">{item.label}{item.value === 'cards' && <small>{count}</small>}</span>} />)}
    </Tabs>
    {hint && <p className="navigation-hint">{hint}</p>}
  </nav>;
}
