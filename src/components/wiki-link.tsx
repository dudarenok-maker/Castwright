/* Curated outbound link to the published GitHub wiki. External, page-level.
   Used across the Help and Admin views (see src/lib/wiki-links.ts). */
import { wikiUrl, type WikiPage } from '../lib/wiki-links';
import { IconExternal } from '../lib/icons';

export function WikiLink({
  page,
  label = 'Read more on the wiki',
  className = '',
}: {
  page: WikiPage;
  label?: string;
  className?: string;
}) {
  return (
    <a
      href={wikiUrl(page)}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 min-h-[44px] fine-pointer:min-h-0 text-sm font-medium text-magenta hover:underline ${className}`}
    >
      {label}
      <IconExternal className="w-3.5 h-3.5" aria-hidden="true" />
    </a>
  );
}
