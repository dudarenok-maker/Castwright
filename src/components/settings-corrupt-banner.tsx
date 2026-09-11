/* #3175 layer 3 — global banner for a recovered settings file. Rendered once
   in the shell banner region (joining WhatsNewBanner / BulkReassignUndoBanner)
   so it's visible from every stage, not just the account view. Visible exactly
   while account.corruptSettingsFile is true; self-clears with no dismiss
   button because the flag itself clears server-side the next time settings
   save successfully (server/src/workspace/user-settings.ts), and the account
   slice's save thunk re-hydrates from that same response — so a save that
   succeeds makes the banner go away on its own. */

import { useAppSelector } from '../store';

export function SettingsCorruptBanner() {
  const corrupt = useAppSelector((s) => s.account.corruptSettingsFile);
  if (!corrupt) return null;
  return (
    <div className="max-w-[1500px] mx-auto px-3 sm:px-6 mt-2">
      <p
        role="alert"
        className="inline-flex items-start gap-2 text-[11px] text-rose-700 max-w-prose"
      >
        <span className="w-1.5 h-1.5 mt-1 rounded-full bg-rose-500 shrink-0" />
        <span>
          Your settings file was unreadable and has been reset to defaults. A
          snapshot of the damaged file will be saved as user-settings.json.corrupt-
          &lt;timestamp&gt; in your Castwright data folder when you next save any
          settings. You can also restore from system backups or a manual copy if you
          have one.
        </span>
      </p>
    </div>
  );
}
