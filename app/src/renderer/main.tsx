import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getConnectionApi, getWorkspacesApi } from './api';
import { StartupScreen } from './StartupScreen';
import { WorkspacesScreen } from './WorkspacesScreen';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StartupScreen
      connection={getConnectionApi()}
      onRetry={() => window.location.reload()}
      connectedView={<WorkspacesScreen api={getWorkspacesApi()} />}
    />
  </StrictMode>,
);
