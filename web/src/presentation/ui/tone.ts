import type { Tone } from '@/domain/position';

/** Text-color class for a value tone (profit/loss/neutral). */
export const toneText: Record<Tone, string> = {
  profit: 'text-profit',
  loss: 'text-loss',
  neutral: 'text-text',
};
