/// Media-key / notification skip-button behaviour (`app-5`, configurable in
/// `app-13`). Defaults to a short seek — an accidental steering-wheel or
/// headset press shouldn't skip a whole chapter.
library;

enum SkipButtonBehavior { seek, chapter }

/// What a skip button should do.
sealed class SkipAction {
  const SkipAction();
}

class SeekBy extends SkipAction {
  const SeekBy(this.delta);
  final Duration delta;
}

class ChapterStep extends SkipAction {
  const ChapterStep(this.direction);

  /// +1 = next chapter, -1 = previous.
  final int direction;
}

/// Resolve a skip-button press into a concrete action. In [SkipButtonBehavior.seek]
/// (the default) a forward press seeks +[forwardSeconds] and a back press
/// -[backwardSeconds]; in [SkipButtonBehavior.chapter] it steps a whole chapter.
SkipAction resolveSkipAction(
  SkipButtonBehavior behavior, {
  required bool forward,
  int forwardSeconds = 30,
  int backwardSeconds = 15,
}) {
  switch (behavior) {
    case SkipButtonBehavior.seek:
      return SeekBy(Duration(seconds: forward ? forwardSeconds : -backwardSeconds));
    case SkipButtonBehavior.chapter:
      return ChapterStep(forward ? 1 : -1);
  }
}
