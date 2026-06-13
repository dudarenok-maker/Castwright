/// Authority of the exported `ArtContentProvider` (see `ArtContentProvider.kt`
/// + `AndroidManifest.xml`). Fixed (not `${applicationId}`-derived) so debug and
/// release builds agree, and so the URI can be built in pure Dart.
const String artProviderAuthority = 'ai.castwright.art';

/// A `content://` URI for a local cover thumbnail that **Android Auto's host
/// process can read** — unlike a private `file://`, which is only readable
/// in-process (so it renders in the notification but not the AA projection /
/// browse rows). Backed by the small exported [ArtContentProvider]. Returns
/// null for an absent path.
Uri? carArtUri(String? filePath) {
  if (filePath == null || filePath.isEmpty) return null;
  return Uri(
    scheme: 'content',
    host: artProviderAuthority,
    path: '/cover',
    queryParameters: {'path': filePath},
  );
}
