import { allKnobs, GROUPS } from './registry.js';

export const BEGIN = '# >>> BEGIN generated config knobs (npm run config:sync) >>>';
export const END = '# <<< END generated config knobs <<<';

export function renderManagedBlock(): string {
  const lines: string[] = [BEGIN];
  for (const g of GROUPS) {
    const knobs = allKnobs().filter((k) => k.group === g.id && !k.isPrompt && k.env);
    if (knobs.length === 0) continue;
    lines.push('', `# ── ${g.label} ──`);
    for (const k of knobs) {
      lines.push(`# ${k.help} [${k.apply}${k.risk === 'high' ? ' · high risk' : ''}]`);
      lines.push(`${k.env}=${String(k.default)}`);
    }
  }
  lines.push('', END);
  return lines.join('\n');
}
