// src/lib/castwave-glyph.tsx
export function CastwaveGlyph({ className }: { className?: string }) {
  // Six ragged bars — the brand "Castwave". currentColor so it tints to text.
  const bars = [
    [0, 4, 10], [3, 1, 13], [6, 5, 9], [9, 2, 12], [12, 6, 8], [15, 3, 11],
  ];
  return (
    <svg className={className} viewBox="0 0 18 16" fill="currentColor" aria-hidden="true">
      {bars.map(([x, top, h], i) => (
        <rect key={i} x={x} y={top} width="2" height={h} rx="1" />
      ))}
    </svg>
  );
}
