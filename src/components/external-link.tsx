/* Curated outbound external link — new tab, safe rel, 44px touch target,
   external-link icon. Shared primitive behind WikiLink and the setup wizard's
   Help & resources footer. */
import { IconExternal } from '../lib/icons';

export function ExternalLink({
  href,
  label,
  className = '',
}: {
  href: string;
  label: string;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 min-h-[44px] fine-pointer:min-h-0 text-sm font-medium text-magenta hover:underline ${className}`}
    >
      {label}
      <IconExternal className="w-3.5 h-3.5" aria-hidden="true" />
    </a>
  );
}
