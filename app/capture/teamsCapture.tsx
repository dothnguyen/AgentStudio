import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '../src/renderer/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BoardsCaptureApp } from './BoardsCaptureApp';
import { RolesCaptureApp } from './RolesCaptureApp';
import { SkillsCaptureApp } from './SkillsCaptureApp';
import { TeamsCaptureApp } from './TeamsCaptureApp';

// The Teams capture is the default page; capture:roles and capture:skills load
// the same built page with ?app=roles or ?app=skills so they share one entry.
const captureApp = new URLSearchParams(window.location.search).get('app');
const app = captureApp === 'boards'
  ? <BoardsCaptureApp />
  : captureApp === 'roles'
    ? <RolesCaptureApp />
    : captureApp === 'skills'
      ? <SkillsCaptureApp />
      : <TeamsCaptureApp />;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {app}
  </StrictMode>,
);
