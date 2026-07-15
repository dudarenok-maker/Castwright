/* Wizard step identity — the ordered first-run setup steps and their ids.
   Lifted out of setup-wizard.tsx (fe-52/fe-53) so src/lib/wiki-links.ts can
   type-only import StepId for its WIZARD_STEP_WIKI map without a lib->component
   runtime cycle. */
export type StepId =
  | 'environment'
  | 'ffmpeg'
  | 'analysis'
  | 'voice'
  | 'defaults'
  | 'lanCert'
  | 'finish';

export const STEPS: { id: StepId; title: string }[] = [
  { id: 'environment', title: 'Environment' },
  { id: 'ffmpeg', title: 'ffmpeg' },
  { id: 'analysis', title: 'Analysis' },
  { id: 'voice', title: 'Voice' },
  { id: 'defaults', title: 'Defaults' },
  { id: 'lanCert', title: 'LAN access' },
  { id: 'finish', title: 'Finish' },
];
