import { createContext, useContext, useLayoutEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import useMediaQuery from '@mui/material/useMediaQuery';
import DarkModeOutlined from '@mui/icons-material/DarkModeOutlined';
import LightModeOutlined from '@mui/icons-material/LightModeOutlined';

type Mode = 'light' | 'dark';
const ThemeMode = createContext({ mode: 'dark' as Mode, toggle: () => {} });
const preferenceKey = 'loacard-color-mode';

export function AppTheme({ children }: { children: ReactNode }) {
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [preference, setPreference] = useState<Mode | null>(() => {
    try { const stored = localStorage.getItem(preferenceKey); return stored === 'light' || stored === 'dark' ? stored : null; }
    catch { return null; }
  });
  const mode = preference ?? (systemDark ? 'dark' : 'light');
  useLayoutEffect(() => { document.documentElement.dataset.theme = mode; }, [mode]);
  const theme = useMemo(() => createTheme({
    palette: {
      mode,
      primary: { main: mode === 'dark' ? '#dec18d' : '#80602e' },
      background: { default: mode === 'dark' ? '#101216' : '#f3f4f6', paper: mode === 'dark' ? '#181b21' : '#ffffff' },
      text: { primary: mode === 'dark' ? '#e7e9ee' : '#202630', secondary: mode === 'dark' ? '#9aa4b4' : '#606c7d' },
      divider: mode === 'dark' ? '#2d323b' : '#e0e4e9',
    },
    typography: { fontFamily: "'Segoe UI', 'Malgun Gothic', sans-serif", fontSize: 13, button: { textTransform: 'none', fontWeight: 600 } },
    shape: { borderRadius: 8 },
    components: {
      MuiButtonBase: { defaultProps: { disableRipple: true } },
      MuiCollapse: { defaultProps: { timeout: reducedMotion ? 0 : 180 } },
      MuiPopover: { defaultProps: { transitionDuration: reducedMotion ? 0 : 150 } },
      MuiButton: { defaultProps: { disableElevation: true, size: 'small' }, styleOverrides: { root: { minHeight: 34, padding: '6px 12px' }, outlined: { borderColor: 'var(--line)', color: 'var(--text)' } } },
      MuiIconButton: { defaultProps: { size: 'small' } },
      MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
      MuiToggleButton: { styleOverrides: { root: { textTransform: 'none', borderColor: 'var(--line)', padding: '5px 14px', fontSize: 12, '&.Mui-selected': { color: 'var(--accent)', backgroundColor: 'var(--accent-soft)' } } } },
      MuiTooltip: { styleOverrides: { tooltip: { fontSize: 12, padding: '8px 10px' } } },
    },
  }), [mode, reducedMotion]);
  const toggle = () => {
    const next = mode === 'dark' ? 'light' : 'dark';
    setPreference(next);
    try { localStorage.setItem(preferenceKey, next); } catch { /* The in-memory choice still works. */ }
  };
  return <ThemeMode.Provider value={{ mode, toggle }}><ThemeProvider theme={theme}><CssBaseline />{children}</ThemeProvider></ThemeMode.Provider>;
}

export function ThemeToggle() {
  const { mode, toggle } = useContext(ThemeMode);
  const label = mode === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환';
  return <Tooltip title={label}><IconButton aria-label={label} onClick={toggle}>
    {mode === 'dark' ? <LightModeOutlined fontSize="small" /> : <DarkModeOutlined fontSize="small" />}
  </IconButton></Tooltip>;
}
