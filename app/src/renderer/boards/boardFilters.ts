import type { BoardTicketSummary } from '../api';

/** The board toolbar's local filter state. Reset whenever the screen is left. */
export interface BoardFilters {
  query: string;
  blockedOnly: boolean;
  workingOnly: boolean;
  hideEmpty: boolean;
}

/** Empty search, no activity filters and the design's default of hiding empty columns. */
export const DEFAULT_BOARD_FILTERS: BoardFilters = {
  query: '',
  blockedOnly: false,
  workingOnly: false,
  hideEmpty: true,
};

/** True when the ticket passes the search and both activity chips (AND). */
export function matchesBoardFilters(
  ticket: BoardTicketSummary,
  filters: Pick<BoardFilters, 'query' | 'blockedOnly' | 'workingOnly'>,
): boolean {
  const query = filters.query.trim().toLowerCase();
  if (query !== '') {
    const key = ticket.key.toLowerCase();
    const title = ticket.title.toLowerCase();
    if (!key.includes(query) && !title.includes(query)) return false;
  }
  if (filters.blockedOnly && ticket.activity.state !== 'blocked') return false;
  if (filters.workingOnly && ticket.activity.state !== 'working') return false;
  return true;
}

/** The visible tickets; cards and lane/column counts are built from this list. */
export function filterBoardTickets(
  tickets: readonly BoardTicketSummary[],
  filters: BoardFilters,
): BoardTicketSummary[] {
  return tickets.filter((ticket) => matchesBoardFilters(ticket, filters));
}

/** "1 ticket" / "3 tickets" for the toolbar's filtered count. */
export function filteredCountLabel(total: number): string {
  return `${total} ${total === 1 ? 'ticket' : 'tickets'}`;
}
