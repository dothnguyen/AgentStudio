import type { JSX } from 'react';

export interface SectionPlaceholderProps {
  sectionId: string;
  title: string;
  description: string;
}

interface SectionContent {
  title: string;
  description: string;
}

export const SECTION_CONTENT: Readonly<Record<string, SectionContent>> = {
  home: {
    title: 'Home',
    description: 'Not available yet. The workspace dashboard will appear here.',
  },
  teams: {
    title: 'Teams',
    description: 'Not available yet. Teams and their members will appear here.',
  },
  boards: {
    title: 'Boards',
    description: 'Not available yet. Board phases and tickets will appear here.',
  },
  configuration: {
    title: 'Configuration',
    description: 'Not available yet. Workspace settings will appear here.',
  },
};

export function getSectionContent(sectionId: string, label: string): SectionContent {
  return SECTION_CONTENT[sectionId] ?? { title: label, description: 'Not available yet.' };
}

export function SectionPlaceholder(props: SectionPlaceholderProps): JSX.Element {
  return (
    <section data-section={props.sectionId}>
      <h1>{props.title}</h1>
      <p>{props.description}</p>
    </section>
  );
}
