import { describe, expect, it } from 'vitest';
import { dealPopupAuto } from './deal-popup';

const vote = { id: 'v1', status: 'open', canVote: true, myVote: null as boolean | null };

describe('dealPopupAuto', () => {
  it('opens for a player who has not answered yet', () => {
    expect(dealPopupAuto(vote, null)).toBe(true);
  });
  it('opens only once per vote, a new vote opens again', () => {
    expect(dealPopupAuto(vote, 'v1')).toBe(false);
    expect(dealPopupAuto({ ...vote, id: 'v2' }, 'v1')).toBe(true);
  });
  it('stays closed for the proposer and for anyone who already answered', () => {
    expect(dealPopupAuto({ ...vote, myVote: true }, null)).toBe(false);
    expect(dealPopupAuto({ ...vote, myVote: false }, null)).toBe(false);
  });
  it('stays closed for spectators and eliminated players', () => {
    expect(dealPopupAuto({ ...vote, canVote: false }, null)).toBe(false);
  });
  it('stays closed when no vote is open', () => {
    expect(dealPopupAuto(null, null)).toBe(false);
    for (const status of ['passed', 'rejected', 'expired', 'cancelled']) expect(dealPopupAuto({ ...vote, status }, null)).toBe(false);
  });
});
