import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getConnectionApi } from './api';
import { CONNECTED_TEXT, StartupScreen } from './StartupScreen';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StartupScreen
      connection={getConnectionApi()}
      onRetry={() => window.location.reload()}
      connectedView={<p>{CONNECTED_TEXT}</p>}
    />
  </StrictMode>,
);
