/** The part of a deal vote that decides whether its window opens by itself at the table. */
export interface DealPopupVote {
  id: string;
  status: string;
  canVote: boolean;
  myVote: boolean | null;
}

/**
 * Should the vote window pop up by itself? Only for a player who still owes an answer, and only once per vote:
 * after closing it (to finish the hand first) it reopens just from the strip above the table.
 */
export function dealPopupAuto(vote: DealPopupVote | null, seenVoteId: string | null): boolean {
  return !!vote && vote.status === 'open' && vote.canVote && vote.myVote === null && vote.id !== seenVoteId;
}
