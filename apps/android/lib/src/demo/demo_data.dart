/// Canonical companion marketing demo content (piece #1b). Mirrors the web
/// fixtures' fictional "The Hollow Tide" series + the real "The Coalfall
/// Commission" — deliberate duplication, Dart can't import the TS fixtures.
/// One source list drives both the fake-server JSON and the Drift seed.
library;

import 'dart:math' as math;

/// One chapter of a demo book.
class DemoChapter {
  const DemoChapter({
    required this.uuid,
    required this.id,
    required this.title,
    required this.durationSec,
  });
  final String uuid;
  final int id;
  final String title;
  final double durationSec;

  /// Synthetic fingerprint (`renderedAt|size`) — any non-empty value marks the
  /// chapter as "downloaded" in the seeded store.
  String get fingerprint => 'demo|1024';
  String get urlSuffix => 'audio.mp3';
}

/// A resume point for the Continue-listening rail + progress bar.
class DemoResume {
  const DemoResume({
    required this.chapterUuid,
    required this.positionMs,
    required this.lastPlayedAt,
  });
  final String chapterUuid;
  final int positionMs;
  final String lastPlayedAt;
}

/// One demo book: manifest metadata + chapters + optional download/resume state.
class DemoBook {
  const DemoBook({
    required this.bookId,
    required this.title,
    required this.author,
    required this.series,
    required this.seriesPosition,
    required this.updatedAt,
    required this.chapters,
    this.downloaded = true,
    this.updateAvailable = false,
    this.resume,
  });
  final String bookId;
  final String title;
  final String author;
  final String series;
  final double? seriesPosition;
  final String updatedAt;
  final List<DemoChapter> chapters;

  /// Seed chapters into Drift (→ "downloaded"); false = "not downloaded".
  final bool downloaded;

  /// Seed the local `updatedAt` OLDER than [updatedAt] so it reads as
  /// "update available".
  final bool updateAvailable;
  final DemoResume? resume;
}

// Each book's chapters carry UNIQUE uuids (uuid is the Drift Chapters primary
// key — sharing a list across books would collide and steal rows).
const _ht1Chapters = [
  DemoChapter(uuid: 'ht1-c1', id: 1, title: 'The Tide Comes In', durationSec: 1420),
  DemoChapter(uuid: 'ht1-c2', id: 2, title: 'Bells Beneath', durationSec: 1675),
  DemoChapter(uuid: 'ht1-c3', id: 3, title: 'The Drowned Quarter', durationSec: 1510),
];

const _ht2Chapters = [
  DemoChapter(uuid: 'ht2-c1', id: 1, title: 'Low Water', durationSec: 1380),
  DemoChapter(uuid: 'ht2-c2', id: 2, title: 'The Oathstone', durationSec: 1605),
  DemoChapter(uuid: 'ht2-c3', id: 3, title: 'Saltlight', durationSec: 1490),
];

const _ht3Chapters = [
  DemoChapter(uuid: 'ht3-c1', id: 1, title: 'The Grave Tide', durationSec: 1450),
  DemoChapter(uuid: 'ht3-c2', id: 2, title: 'Underforth', durationSec: 1700),
  DemoChapter(uuid: 'ht3-c3', id: 3, title: 'The Last Bell', durationSec: 1525),
];

const _coalfallChapters = [
  DemoChapter(uuid: 'cf-c3', id: 3, title: 'Chapter One — The Knock', durationSec: 1980),
  DemoChapter(uuid: 'cf-c4', id: 4, title: 'Chapter Two — The Pour', durationSec: 2120),
];

/// The demo library. States are mixed on purpose so the library shot shows the
/// full range of affordances.
const demoBooks = <DemoBook>[
  DemoBook(
    bookId: 'hollow-tide-1',
    title: 'The Drowning Bell',
    author: 'Marin Vale',
    series: 'The Hollow Tide',
    seriesPosition: 1,
    updatedAt: '2026-05-01T10:00:00Z',
    chapters: _ht1Chapters,
    downloaded: true,
    resume: DemoResume(
        chapterUuid: 'ht1-c2', positionMs: 540000, lastPlayedAt: '2026-06-10T20:00:00Z'),
  ),
  DemoBook(
    bookId: 'hollow-tide-2',
    title: "The Tidewatcher's Oath",
    author: 'Marin Vale',
    series: 'The Hollow Tide',
    seriesPosition: 2,
    updatedAt: '2026-05-20T10:00:00Z',
    chapters: _ht2Chapters,
    downloaded: true,
    updateAvailable: true,
  ),
  DemoBook(
    bookId: 'hollow-tide-3',
    title: 'Saltgrave',
    author: 'Marin Vale',
    series: 'The Hollow Tide',
    seriesPosition: 3,
    updatedAt: '2026-05-28T10:00:00Z',
    chapters: _ht3Chapters,
    downloaded: false,
  ),
  DemoBook(
    bookId: 'coalfall-commission',
    title: 'The Coalfall Commission',
    author: 'Castwright',
    series: 'Standalones',
    seriesPosition: null,
    updatedAt: '2026-05-15T10:00:00Z',
    chapters: _coalfallChapters,
    downloaded: true,
    resume: DemoResume(
        chapterUuid: 'cf-c3', positionMs: 300000, lastPlayedAt: '2026-06-11T09:00:00Z'),
  ),
];

/// 240 normalized RMS bins for the player waveform (a smooth pseudo-random
/// envelope — deterministic, no RNG).
final List<double> demoPeaks = List<double>.generate(240, (i) {
  final a = 0.5 + 0.4 * math.sin(i * 0.20);
  final b = 0.2 * math.sin(i * 0.07);
  final v = a + b;
  return v < 0.05 ? 0.05 : (v > 1.0 ? 1.0 : v);
});

/// The fake-server INDEX body.
Map<String, dynamic> demoIndexJson() => {
      'schemaVersion': 1,
      'books': [
        for (final b in demoBooks)
          {
            'bookId': b.bookId,
            'updatedAt': b.updatedAt,
            'title': b.title,
            'author': b.author,
            'series': b.series,
            'seriesPosition': b.seriesPosition,
            'chapterCount': b.chapters.length,
          },
      ],
      'activeBookIds': [for (final b in demoBooks) b.bookId],
    };

/// The fake-server DETAIL body for [bookId].
Map<String, dynamic> demoDetailJson(String bookId) {
  final book = demoBooks.firstWhere((b) => b.bookId == bookId);
  return {
    'schemaVersion': 1,
    'bookId': book.bookId,
    'updatedAt': book.updatedAt,
    'chapters': [
      for (final c in book.chapters)
        {
          'uuid': c.uuid,
          'id': c.id,
          'title': c.title,
          'fingerprint': c.fingerprint,
          'urlSuffix': c.urlSuffix,
          'audioUrl': '/api/books/${book.bookId}/chapters/${c.id}/${c.urlSuffix}',
          'durationSec': c.durationSec,
        },
    ],
    'activeChapterUuids': [for (final c in book.chapters) c.uuid],
  };
}
