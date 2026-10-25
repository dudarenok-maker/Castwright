/* #3084 W4 — does a design run about to start generate any voice description (persona)?
   Mirrors the server's persona pre-pass (cast-design.ts runPersonaPrePass): a base design makes a
   persona call only for a character with an empty `voiceStyle`. The pause-the-render prompt is
   asked only when this is true — a run that makes no persona call has nothing that competes with
   the render for the card. A target the roster does not hold is assumed to need one (the
   conservative answer: prompt rather than race the render). Each design entry point passes the
   ids ITS path will actually design. */
export function designWillGeneratePersona(
  characters: readonly { id: string; voiceStyle?: string | null }[] | undefined,
  targetIds: readonly string[],
): boolean {
  const byId = new Map((characters ?? []).map((c) => [c.id, c]));
  return targetIds.some((id) => {
    const c = byId.get(id);
    return !c || !(c.voiceStyle ?? '').trim();
  });
}
