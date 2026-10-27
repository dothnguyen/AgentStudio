import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getConnectionApi, getDashboardApi, getManagementApi, getWorkspacesApi } from './api';
import { StartupScreen } from './StartupScreen';
import { WorkspacesScreen } from './WorkspacesScreen';

const connectionApi = getConnectionApi();
const workspacesApi = getWorkspacesApi();
const dashboardApi = getDashboardApi();
const managementApi = getManagementApi();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StartupScreen
      connection={connectionApi}
      onRetry={() => window.location.reload()}
      connectedView={(status) => (
        <WorkspacesScreen api={workspacesApi} dashboard={dashboardApi} management={managementApi} connection={status} />
      )}
    />
  </StrictMode>,
);
