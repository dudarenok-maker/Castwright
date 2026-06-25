import { useState } from 'react';

type Fields = { name: string; gender?: string; ageRange?: string };

export function CreateCharacterForm({
  initial,
  rosterByName,
  onSubmit,
  onReattributeExisting,
  onCancel,
}: {
  initial?: Fields;
  rosterByName: Map<string, { id: string; name: string }>;
  onSubmit: (f: Fields) => void;
  onReattributeExisting?: (characterId: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [gender, setGender] = useState(initial?.gender ?? '');
  const [ageRange, setAgeRange] = useState(initial?.ageRange ?? '');

  const key = name.trim().toLowerCase();
  const existing = key ? rosterByName.get(key) : undefined;
  const disabled = key.length === 0;

  const selectClass =
    'mt-1 w-full min-h-[44px] sm:min-h-0 rounded-xl border border-ink/15 px-3 text-sm bg-canvas text-ink';

  return (
    <div className="space-y-3" data-testid="create-character-form">
      <label className="block text-xs font-semibold text-ink/70">
        Name
        <input
          aria-label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full min-h-[44px] sm:min-h-0 rounded-xl border border-ink/15 px-3 text-sm bg-canvas text-ink"
        />
      </label>

      <label className="block text-xs font-semibold text-ink/70">
        Gender
        <select
          aria-label="Gender"
          value={gender}
          onChange={(e) => setGender(e.target.value)}
          className={selectClass}
        >
          <option value="">—</option>
          <option value="male">Male</option>
          <option value="female">Female</option>
          <option value="neutral">Neutral</option>
        </select>
      </label>

      <label className="block text-xs font-semibold text-ink/70">
        Age range
        <select
          aria-label="Age range"
          value={ageRange}
          onChange={(e) => setAgeRange(e.target.value)}
          className={selectClass}
        >
          <option value="">—</option>
          <option value="child">Child</option>
          <option value="teen">Teen</option>
          <option value="adult">Adult</option>
          <option value="elderly">Elderly</option>
        </select>
      </label>

      {existing && (
        <p className="text-xs text-ink/55">A character named «{existing.name}» already exists.</p>
      )}

      <div className="flex gap-2">
        <button
          data-testid="create-character-submit"
          disabled={disabled}
          onClick={() =>
            existing
              ? onReattributeExisting?.(existing.id)
              : onSubmit({
                  name: name.trim(),
                  gender: gender || undefined,
                  ageRange: ageRange || undefined,
                })
          }
          className="px-4 min-h-[44px] sm:min-h-0 rounded-full bg-ink text-canvas text-sm font-semibold disabled:opacity-40"
        >
          {existing ? `Reattribute to «${existing.name}»` : 'Create character'}
        </button>
        <button onClick={onCancel} className="px-4 min-h-[44px] sm:min-h-0 text-sm text-ink/50">
          Cancel
        </button>
      </div>
    </div>
  );
}
