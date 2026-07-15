/* fe-52 — persistent "Need help?" footer for the first-run setup wizard.
   Five outbound links (new tab, safe rel), visible on every wizard surface.
   All URLs come from the shared src/lib/wiki-links.ts module. */
import { ExternalLink } from '../external-link';
import { wikiUrl, SUPPORT_LINKS } from '../../lib/wiki-links';

export function HelpResources() {
  return (
    <div className="mt-8 pt-5 border-t border-ink/10 flex flex-wrap items-center gap-x-4 gap-y-1">
      <span className="text-sm font-medium text-ink/60">Need help?</span>
      <ExternalLink href={wikiUrl('Getting-Started')} label="Getting started" />
      <ExternalLink href={wikiUrl('Installing-Castwright')} label="Install &amp; setup" />
      <ExternalLink href={wikiUrl('Troubleshooting')} label="Troubleshooting" />
      <ExternalLink href={SUPPORT_LINKS.issues} label="Report a problem" />
      <ExternalLink href={SUPPORT_LINKS.discussions} label="Ask a question" />
    </div>
  );
}
