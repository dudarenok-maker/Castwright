/* fs-23 — In-app Model Manager. Consolidates every model install / inventory /
   residency control that used to be scattered across the Account view: a
   per-model inventory (present? · size · disk path · live residency) with
   Load/Unload/Install/Remove actions, plus the model-flavored settings moved
   out of Account (defaults, analyzer split, TTS sidecar, server config).

   Reached only from the Admin view (#/models). NOTE: stub — the inventory
   table + moved form sections land in fs-23 step A5. */

import { SectionLabel, MixedHeading } from '../components/primitives';

export function ModelManagerView() {
  return (
    <div className="max-w-[960px] mx-auto px-6 py-10">
      <div className="mb-8">
        <SectionLabel>Admin</SectionLabel>
        <div className="mt-4">
          <MixedHeading regular="Model" bold="Manager" level="h1" />
        </div>
        <p className="mt-3 text-ink/60 max-w-xl">
          Install, remove, and update your local models, see disk usage, and load or unload each into
          the GPU.
        </p>
      </div>
    </div>
  );
}
