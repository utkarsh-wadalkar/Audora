import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import LiveProgressPanelDemo from './components/LiveProgressPanelDemo';
import './index.css';

// --- DEV-ONLY: LiveProgressPanel harness (Workstream D) ---------------------
// Reachable ONLY with `?panelDemo=1` in the URL; the default app startup path
// and wizard flow are untouched. Remove this block (and the import above) to
// fully revert. See LiveProgressPanelDemo.tsx for details.
const panelDemo =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('panelDemo') === '1';

const root = ReactDOM.createRoot(document.getElementById('root')!);

if (panelDemo) {
  root.render(
    <React.StrictMode>
      <LiveProgressPanelDemo />
    </React.StrictMode>
  );
} else {
  // HashRouter (not BrowserRouter) so routing works under Electron's file://.
  root.render(
    <React.StrictMode>
      <HashRouter>
        <App />
      </HashRouter>
    </React.StrictMode>
  );
}
