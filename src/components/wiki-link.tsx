/* Curated outbound link to the published GitHub wiki. External, page-level.
   Thin wrapper over ExternalLink. Used across the Help and Admin views
   (see src/lib/wiki-links.ts). */
import { ExternalLink } from './external-link';
import { wikiUrl, type WikiPage } from '../lib/wiki-links';

export function WikiLink({
  page,
  label = 'Read more on the wiki',
  className = '',
}: {
  page: WikiPage;
  label?: string;
  className?: string;
}) {
  return <ExternalLink href={wikiUrl(page)} label={label} className={className} />;
}
