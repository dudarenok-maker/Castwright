/// Material 3 window size classes, derived purely from logical width (dp).
/// Platform-neutral: an iPad classifies identically to an Android tablet.
enum WindowSizeClass { compact, medium, expanded }

WindowSizeClass windowSizeClassFor(double widthDp) {
  if (widthDp < 600) return WindowSizeClass.compact;
  if (widthDp < 840) return WindowSizeClass.medium;
  return WindowSizeClass.expanded;
}

/// Whether the library shows a persistent detail pane (two-pane) or pushes the
/// player as a route (single-pane). Two-pane only at the expanded breakpoint.
enum LibraryLayout { singlePane, twoPane }

LibraryLayout libraryLayoutFor(WindowSizeClass c) =>
    c == WindowSizeClass.expanded ? LibraryLayout.twoPane : LibraryLayout.singlePane;
