import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '../src/renderer/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TeamsCaptureApp } from './TeamsCaptureApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TeamsCaptureApp />
  </StrictMode>,
);
