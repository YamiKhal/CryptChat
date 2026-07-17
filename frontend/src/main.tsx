import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { SessionProvider } from './lib/session';
import { applyTheme, getTheme } from './lib/theme';
import CustomThemeApplier from './components/CustomThemeApplier';
import './index.css';

// The inline script in index.html already stamped the theme before paint; this
// re-asserts it from the same source of truth in case that script was stripped
// by a proxy or an aggressive CSP. Cheap and idempotent.
applyTheme(getTheme());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <CustomThemeApplier />
        <App />
      </SessionProvider>
    </BrowserRouter>
  </React.StrictMode>
);
