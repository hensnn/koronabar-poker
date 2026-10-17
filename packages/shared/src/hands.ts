/** Reakce, které jde dát na sdílenou handu. */
export const HAND_REACTIONS = ['👍', '🔥', '😮', '😂', '🤔', '💀'] as const;
export type HandReaction = (typeof HAND_REACTIONS)[number];
