/**
 * What a supporter account unlocks, free tier beside it.
 *
 * One list, so the comparison table and the marketing never disagree. Every row
 * here maps to a real server- or client-side gate: file caps and character caps
 * come from `/account/limits`; calls, screen share, locked and burning messages
 * are gated on `limits.premium`; custom colours and wallpaper are gated in the
 * theme editor. Nothing on this list is aspirational.
 *
 * `free: null` means the row is supporter-only. A string in either column is the
 * concrete value shown; `yes` renders as a check.
 */
export interface Perk {
  label: string;
  free: string | null;
  supporter: string;
}

export const PERKS: Perk[] = [
  { label: 'File uploads', free: '20 MB', supporter: '50 MB' },
  { label: 'Message length', free: '1,000', supporter: '4,000' },
  { label: 'Supporter crown', free: null, supporter: 'yes' },
  { label: 'Video calls', free: null, supporter: 'yes' },
  { label: 'Screen sharing', free: null, supporter: 'yes' },
  { label: 'Locked messages', free: null, supporter: 'yes' },
  { label: 'Burning messages', free: null, supporter: 'yes' },
  { label: 'Custom colours & wallpaper', free: null, supporter: 'yes' },
];
