import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '../src/renderer/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RolesCaptureApp } from './RolesCaptureApp';
import { TeamsCaptureApp } from './TeamsCaptureApp';

// The Teams capture is the default page; capture:roles loads the same built
// page with ?app=roles so both commands share one Vite entry.
const app = new URLSearchParams(window.location.search).get('app') === 'roles'
  ? <RolesCaptureApp />
  : <TeamsCaptureApp />;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {app}
  </StrictMode>,
);
