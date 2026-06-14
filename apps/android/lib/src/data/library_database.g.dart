// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'library_database.dart';

// ignore_for_file: type=lint
class $BooksTable extends Books with TableInfo<$BooksTable, Book> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $BooksTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _bookIdMeta = const VerificationMeta('bookId');
  @override
  late final GeneratedColumn<String> bookId = GeneratedColumn<String>(
    'book_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<String> updatedAt = GeneratedColumn<String>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _titleMeta = const VerificationMeta('title');
  @override
  late final GeneratedColumn<String> title = GeneratedColumn<String>(
    'title',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _authorMeta = const VerificationMeta('author');
  @override
  late final GeneratedColumn<String> author = GeneratedColumn<String>(
    'author',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _seriesMeta = const VerificationMeta('series');
  @override
  late final GeneratedColumn<String> series = GeneratedColumn<String>(
    'series',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _seriesPositionMeta = const VerificationMeta(
    'seriesPosition',
  );
  @override
  late final GeneratedColumn<int> seriesPosition = GeneratedColumn<int>(
    'series_position',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _lastPlayedAtMeta = const VerificationMeta(
    'lastPlayedAt',
  );
  @override
  late final GeneratedColumn<String> lastPlayedAt = GeneratedColumn<String>(
    'last_played_at',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _coverThumbPathMeta = const VerificationMeta(
    'coverThumbPath',
  );
  @override
  late final GeneratedColumn<String> coverThumbPath = GeneratedColumn<String>(
    'cover_thumb_path',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  @override
  List<GeneratedColumn> get $columns => [
    bookId,
    updatedAt,
    title,
    author,
    series,
    seriesPosition,
    lastPlayedAt,
    coverThumbPath,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'books';
  @override
  VerificationContext validateIntegrity(
    Insertable<Book> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('book_id')) {
      context.handle(
        _bookIdMeta,
        bookId.isAcceptableOrUnknown(data['book_id']!, _bookIdMeta),
      );
    } else if (isInserting) {
      context.missing(_bookIdMeta);
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    }
    if (data.containsKey('title')) {
      context.handle(
        _titleMeta,
        title.isAcceptableOrUnknown(data['title']!, _titleMeta),
      );
    }
    if (data.containsKey('author')) {
      context.handle(
        _authorMeta,
        author.isAcceptableOrUnknown(data['author']!, _authorMeta),
      );
    }
    if (data.containsKey('series')) {
      context.handle(
        _seriesMeta,
        series.isAcceptableOrUnknown(data['series']!, _seriesMeta),
      );
    }
    if (data.containsKey('series_position')) {
      context.handle(
        _seriesPositionMeta,
        seriesPosition.isAcceptableOrUnknown(
          data['series_position']!,
          _seriesPositionMeta,
        ),
      );
    }
    if (data.containsKey('last_played_at')) {
      context.handle(
        _lastPlayedAtMeta,
        lastPlayedAt.isAcceptableOrUnknown(
          data['last_played_at']!,
          _lastPlayedAtMeta,
        ),
      );
    }
    if (data.containsKey('cover_thumb_path')) {
      context.handle(
        _coverThumbPathMeta,
        coverThumbPath.isAcceptableOrUnknown(
          data['cover_thumb_path']!,
          _coverThumbPathMeta,
        ),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {bookId};
  @override
  Book map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return Book(
      bookId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}book_id'],
      )!,
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}updated_at'],
      )!,
      title: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}title'],
      )!,
      author: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}author'],
      )!,
      series: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}series'],
      )!,
      seriesPosition: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}series_position'],
      ),
      lastPlayedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}last_played_at'],
      ),
      coverThumbPath: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}cover_thumb_path'],
      ),
    );
  }

  @override
  $BooksTable createAlias(String alias) {
    return $BooksTable(attachedDatabase, alias);
  }
}

class Book extends DataClass implements Insertable<Book> {
  final String bookId;
  final String updatedAt;
  final String title;
  final String author;
  final String series;
  final int? seriesPosition;

  /// ISO timestamp of the last time the user played this book — drives
  /// least-recently-listened book eviction.
  final String? lastPlayedAt;

  /// On-disk path of the cached ~250×250 cover thumbnail (client-downscaled).
  final String? coverThumbPath;
  const Book({
    required this.bookId,
    required this.updatedAt,
    required this.title,
    required this.author,
    required this.series,
    this.seriesPosition,
    this.lastPlayedAt,
    this.coverThumbPath,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['book_id'] = Variable<String>(bookId);
    map['updated_at'] = Variable<String>(updatedAt);
    map['title'] = Variable<String>(title);
    map['author'] = Variable<String>(author);
    map['series'] = Variable<String>(series);
    if (!nullToAbsent || seriesPosition != null) {
      map['series_position'] = Variable<int>(seriesPosition);
    }
    if (!nullToAbsent || lastPlayedAt != null) {
      map['last_played_at'] = Variable<String>(lastPlayedAt);
    }
    if (!nullToAbsent || coverThumbPath != null) {
      map['cover_thumb_path'] = Variable<String>(coverThumbPath);
    }
    return map;
  }

  BooksCompanion toCompanion(bool nullToAbsent) {
    return BooksCompanion(
      bookId: Value(bookId),
      updatedAt: Value(updatedAt),
      title: Value(title),
      author: Value(author),
      series: Value(series),
      seriesPosition: seriesPosition == null && nullToAbsent
          ? const Value.absent()
          : Value(seriesPosition),
      lastPlayedAt: lastPlayedAt == null && nullToAbsent
          ? const Value.absent()
          : Value(lastPlayedAt),
      coverThumbPath: coverThumbPath == null && nullToAbsent
          ? const Value.absent()
          : Value(coverThumbPath),
    );
  }

  factory Book.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return Book(
      bookId: serializer.fromJson<String>(json['bookId']),
      updatedAt: serializer.fromJson<String>(json['updatedAt']),
      title: serializer.fromJson<String>(json['title']),
      author: serializer.fromJson<String>(json['author']),
      series: serializer.fromJson<String>(json['series']),
      seriesPosition: serializer.fromJson<int?>(json['seriesPosition']),
      lastPlayedAt: serializer.fromJson<String?>(json['lastPlayedAt']),
      coverThumbPath: serializer.fromJson<String?>(json['coverThumbPath']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'bookId': serializer.toJson<String>(bookId),
      'updatedAt': serializer.toJson<String>(updatedAt),
      'title': serializer.toJson<String>(title),
      'author': serializer.toJson<String>(author),
      'series': serializer.toJson<String>(series),
      'seriesPosition': serializer.toJson<int?>(seriesPosition),
      'lastPlayedAt': serializer.toJson<String?>(lastPlayedAt),
      'coverThumbPath': serializer.toJson<String?>(coverThumbPath),
    };
  }

  Book copyWith({
    String? bookId,
    String? updatedAt,
    String? title,
    String? author,
    String? series,
    Value<int?> seriesPosition = const Value.absent(),
    Value<String?> lastPlayedAt = const Value.absent(),
    Value<String?> coverThumbPath = const Value.absent(),
  }) => Book(
    bookId: bookId ?? this.bookId,
    updatedAt: updatedAt ?? this.updatedAt,
    title: title ?? this.title,
    author: author ?? this.author,
    series: series ?? this.series,
    seriesPosition: seriesPosition.present
        ? seriesPosition.value
        : this.seriesPosition,
    lastPlayedAt: lastPlayedAt.present ? lastPlayedAt.value : this.lastPlayedAt,
    coverThumbPath: coverThumbPath.present
        ? coverThumbPath.value
        : this.coverThumbPath,
  );
  Book copyWithCompanion(BooksCompanion data) {
    return Book(
      bookId: data.bookId.present ? data.bookId.value : this.bookId,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
      title: data.title.present ? data.title.value : this.title,
      author: data.author.present ? data.author.value : this.author,
      series: data.series.present ? data.series.value : this.series,
      seriesPosition: data.seriesPosition.present
          ? data.seriesPosition.value
          : this.seriesPosition,
      lastPlayedAt: data.lastPlayedAt.present
          ? data.lastPlayedAt.value
          : this.lastPlayedAt,
      coverThumbPath: data.coverThumbPath.present
          ? data.coverThumbPath.value
          : this.coverThumbPath,
    );
  }

  @override
  String toString() {
    return (StringBuffer('Book(')
          ..write('bookId: $bookId, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('title: $title, ')
          ..write('author: $author, ')
          ..write('series: $series, ')
          ..write('seriesPosition: $seriesPosition, ')
          ..write('lastPlayedAt: $lastPlayedAt, ')
          ..write('coverThumbPath: $coverThumbPath')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    bookId,
    updatedAt,
    title,
    author,
    series,
    seriesPosition,
    lastPlayedAt,
    coverThumbPath,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is Book &&
          other.bookId == this.bookId &&
          other.updatedAt == this.updatedAt &&
          other.title == this.title &&
          other.author == this.author &&
          other.series == this.series &&
          other.seriesPosition == this.seriesPosition &&
          other.lastPlayedAt == this.lastPlayedAt &&
          other.coverThumbPath == this.coverThumbPath);
}

class BooksCompanion extends UpdateCompanion<Book> {
  final Value<String> bookId;
  final Value<String> updatedAt;
  final Value<String> title;
  final Value<String> author;
  final Value<String> series;
  final Value<int?> seriesPosition;
  final Value<String?> lastPlayedAt;
  final Value<String?> coverThumbPath;
  final Value<int> rowid;
  const BooksCompanion({
    this.bookId = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.title = const Value.absent(),
    this.author = const Value.absent(),
    this.series = const Value.absent(),
    this.seriesPosition = const Value.absent(),
    this.lastPlayedAt = const Value.absent(),
    this.coverThumbPath = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  BooksCompanion.insert({
    required String bookId,
    this.updatedAt = const Value.absent(),
    this.title = const Value.absent(),
    this.author = const Value.absent(),
    this.series = const Value.absent(),
    this.seriesPosition = const Value.absent(),
    this.lastPlayedAt = const Value.absent(),
    this.coverThumbPath = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : bookId = Value(bookId);
  static Insertable<Book> custom({
    Expression<String>? bookId,
    Expression<String>? updatedAt,
    Expression<String>? title,
    Expression<String>? author,
    Expression<String>? series,
    Expression<int>? seriesPosition,
    Expression<String>? lastPlayedAt,
    Expression<String>? coverThumbPath,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (bookId != null) 'book_id': bookId,
      if (updatedAt != null) 'updated_at': updatedAt,
      if (title != null) 'title': title,
      if (author != null) 'author': author,
      if (series != null) 'series': series,
      if (seriesPosition != null) 'series_position': seriesPosition,
      if (lastPlayedAt != null) 'last_played_at': lastPlayedAt,
      if (coverThumbPath != null) 'cover_thumb_path': coverThumbPath,
      if (rowid != null) 'rowid': rowid,
    });
  }

  BooksCompanion copyWith({
    Value<String>? bookId,
    Value<String>? updatedAt,
    Value<String>? title,
    Value<String>? author,
    Value<String>? series,
    Value<int?>? seriesPosition,
    Value<String?>? lastPlayedAt,
    Value<String?>? coverThumbPath,
    Value<int>? rowid,
  }) {
    return BooksCompanion(
      bookId: bookId ?? this.bookId,
      updatedAt: updatedAt ?? this.updatedAt,
      title: title ?? this.title,
      author: author ?? this.author,
      series: series ?? this.series,
      seriesPosition: seriesPosition ?? this.seriesPosition,
      lastPlayedAt: lastPlayedAt ?? this.lastPlayedAt,
      coverThumbPath: coverThumbPath ?? this.coverThumbPath,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (bookId.present) {
      map['book_id'] = Variable<String>(bookId.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<String>(updatedAt.value);
    }
    if (title.present) {
      map['title'] = Variable<String>(title.value);
    }
    if (author.present) {
      map['author'] = Variable<String>(author.value);
    }
    if (series.present) {
      map['series'] = Variable<String>(series.value);
    }
    if (seriesPosition.present) {
      map['series_position'] = Variable<int>(seriesPosition.value);
    }
    if (lastPlayedAt.present) {
      map['last_played_at'] = Variable<String>(lastPlayedAt.value);
    }
    if (coverThumbPath.present) {
      map['cover_thumb_path'] = Variable<String>(coverThumbPath.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('BooksCompanion(')
          ..write('bookId: $bookId, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('title: $title, ')
          ..write('author: $author, ')
          ..write('series: $series, ')
          ..write('seriesPosition: $seriesPosition, ')
          ..write('lastPlayedAt: $lastPlayedAt, ')
          ..write('coverThumbPath: $coverThumbPath, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $ChaptersTable extends Chapters with TableInfo<$ChaptersTable, Chapter> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $ChaptersTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _uuidMeta = const VerificationMeta('uuid');
  @override
  late final GeneratedColumn<String> uuid = GeneratedColumn<String>(
    'uuid',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _bookIdMeta = const VerificationMeta('bookId');
  @override
  late final GeneratedColumn<String> bookId = GeneratedColumn<String>(
    'book_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _chapterIdMeta = const VerificationMeta(
    'chapterId',
  );
  @override
  late final GeneratedColumn<int> chapterId = GeneratedColumn<int>(
    'chapter_id',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _titleMeta = const VerificationMeta('title');
  @override
  late final GeneratedColumn<String> title = GeneratedColumn<String>(
    'title',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _fingerprintMeta = const VerificationMeta(
    'fingerprint',
  );
  @override
  late final GeneratedColumn<String> fingerprint = GeneratedColumn<String>(
    'fingerprint',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _urlSuffixMeta = const VerificationMeta(
    'urlSuffix',
  );
  @override
  late final GeneratedColumn<String> urlSuffix = GeneratedColumn<String>(
    'url_suffix',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _bytesMeta = const VerificationMeta('bytes');
  @override
  late final GeneratedColumn<int> bytes = GeneratedColumn<int>(
    'bytes',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _durationSecMeta = const VerificationMeta(
    'durationSec',
  );
  @override
  late final GeneratedColumn<double> durationSec = GeneratedColumn<double>(
    'duration_sec',
    aliasedName,
    true,
    type: DriftSqlType.double,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _peaksMeta = const VerificationMeta('peaks');
  @override
  late final GeneratedColumn<String> peaks = GeneratedColumn<String>(
    'peaks',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _finishedMeta = const VerificationMeta(
    'finished',
  );
  @override
  late final GeneratedColumn<bool> finished = GeneratedColumn<bool>(
    'finished',
    aliasedName,
    false,
    type: DriftSqlType.bool,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'CHECK ("finished" IN (0, 1))',
    ),
    defaultValue: const Constant(false),
  );
  @override
  List<GeneratedColumn> get $columns => [
    uuid,
    bookId,
    chapterId,
    title,
    fingerprint,
    urlSuffix,
    bytes,
    durationSec,
    peaks,
    finished,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'chapters';
  @override
  VerificationContext validateIntegrity(
    Insertable<Chapter> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('uuid')) {
      context.handle(
        _uuidMeta,
        uuid.isAcceptableOrUnknown(data['uuid']!, _uuidMeta),
      );
    } else if (isInserting) {
      context.missing(_uuidMeta);
    }
    if (data.containsKey('book_id')) {
      context.handle(
        _bookIdMeta,
        bookId.isAcceptableOrUnknown(data['book_id']!, _bookIdMeta),
      );
    } else if (isInserting) {
      context.missing(_bookIdMeta);
    }
    if (data.containsKey('chapter_id')) {
      context.handle(
        _chapterIdMeta,
        chapterId.isAcceptableOrUnknown(data['chapter_id']!, _chapterIdMeta),
      );
    } else if (isInserting) {
      context.missing(_chapterIdMeta);
    }
    if (data.containsKey('title')) {
      context.handle(
        _titleMeta,
        title.isAcceptableOrUnknown(data['title']!, _titleMeta),
      );
    }
    if (data.containsKey('fingerprint')) {
      context.handle(
        _fingerprintMeta,
        fingerprint.isAcceptableOrUnknown(
          data['fingerprint']!,
          _fingerprintMeta,
        ),
      );
    }
    if (data.containsKey('url_suffix')) {
      context.handle(
        _urlSuffixMeta,
        urlSuffix.isAcceptableOrUnknown(data['url_suffix']!, _urlSuffixMeta),
      );
    }
    if (data.containsKey('bytes')) {
      context.handle(
        _bytesMeta,
        bytes.isAcceptableOrUnknown(data['bytes']!, _bytesMeta),
      );
    }
    if (data.containsKey('duration_sec')) {
      context.handle(
        _durationSecMeta,
        durationSec.isAcceptableOrUnknown(
          data['duration_sec']!,
          _durationSecMeta,
        ),
      );
    }
    if (data.containsKey('peaks')) {
      context.handle(
        _peaksMeta,
        peaks.isAcceptableOrUnknown(data['peaks']!, _peaksMeta),
      );
    }
    if (data.containsKey('finished')) {
      context.handle(
        _finishedMeta,
        finished.isAcceptableOrUnknown(data['finished']!, _finishedMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {uuid};
  @override
  Chapter map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return Chapter(
      uuid: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}uuid'],
      )!,
      bookId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}book_id'],
      )!,
      chapterId: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}chapter_id'],
      )!,
      title: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}title'],
      )!,
      fingerprint: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}fingerprint'],
      ),
      urlSuffix: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}url_suffix'],
      ),
      bytes: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}bytes'],
      )!,
      durationSec: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}duration_sec'],
      ),
      peaks: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}peaks'],
      ),
      finished: attachedDatabase.typeMapping.read(
        DriftSqlType.bool,
        data['${effectivePrefix}finished'],
      )!,
    );
  }

  @override
  $ChaptersTable createAlias(String alias) {
    return $ChaptersTable(attachedDatabase, alias);
  }
}

class Chapter extends DataClass implements Insertable<Chapter> {
  final String uuid;
  final String bookId;

  /// Current positional id (for building the audio URL); keying is by [uuid].
  final int chapterId;
  final String title;

  /// `audioRenderedAt|fileSize` — null when no audio is downloaded.
  final String? fingerprint;
  final String? urlSuffix;

  /// On-disk byte size of the downloaded audio (0 when absent) — drives
  /// storage accounting.
  final int bytes;

  /// PCM-measured chapter length (seconds) from the manifest — stored so the
  /// player + library show durations + listener progress OFFLINE.
  final double? durationSec;

  /// Waveform peaks for the player (the server's 240 normalized RMS bins),
  /// JSON-encoded as a `List<double>`. Null until fetched — persisted so the
  /// waveform survives offline / screen recreation / restart instead of being
  /// re-fetched live every time.
  final String? peaks;

  /// Whether the user has finished this chapter — drives auto-delete-finished
  /// eviction (the row stays; only the audio file is dropped).
  final bool finished;
  const Chapter({
    required this.uuid,
    required this.bookId,
    required this.chapterId,
    required this.title,
    this.fingerprint,
    this.urlSuffix,
    required this.bytes,
    this.durationSec,
    this.peaks,
    required this.finished,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['uuid'] = Variable<String>(uuid);
    map['book_id'] = Variable<String>(bookId);
    map['chapter_id'] = Variable<int>(chapterId);
    map['title'] = Variable<String>(title);
    if (!nullToAbsent || fingerprint != null) {
      map['fingerprint'] = Variable<String>(fingerprint);
    }
    if (!nullToAbsent || urlSuffix != null) {
      map['url_suffix'] = Variable<String>(urlSuffix);
    }
    map['bytes'] = Variable<int>(bytes);
    if (!nullToAbsent || durationSec != null) {
      map['duration_sec'] = Variable<double>(durationSec);
    }
    if (!nullToAbsent || peaks != null) {
      map['peaks'] = Variable<String>(peaks);
    }
    map['finished'] = Variable<bool>(finished);
    return map;
  }

  ChaptersCompanion toCompanion(bool nullToAbsent) {
    return ChaptersCompanion(
      uuid: Value(uuid),
      bookId: Value(bookId),
      chapterId: Value(chapterId),
      title: Value(title),
      fingerprint: fingerprint == null && nullToAbsent
          ? const Value.absent()
          : Value(fingerprint),
      urlSuffix: urlSuffix == null && nullToAbsent
          ? const Value.absent()
          : Value(urlSuffix),
      bytes: Value(bytes),
      durationSec: durationSec == null && nullToAbsent
          ? const Value.absent()
          : Value(durationSec),
      peaks: peaks == null && nullToAbsent
          ? const Value.absent()
          : Value(peaks),
      finished: Value(finished),
    );
  }

  factory Chapter.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return Chapter(
      uuid: serializer.fromJson<String>(json['uuid']),
      bookId: serializer.fromJson<String>(json['bookId']),
      chapterId: serializer.fromJson<int>(json['chapterId']),
      title: serializer.fromJson<String>(json['title']),
      fingerprint: serializer.fromJson<String?>(json['fingerprint']),
      urlSuffix: serializer.fromJson<String?>(json['urlSuffix']),
      bytes: serializer.fromJson<int>(json['bytes']),
      durationSec: serializer.fromJson<double?>(json['durationSec']),
      peaks: serializer.fromJson<String?>(json['peaks']),
      finished: serializer.fromJson<bool>(json['finished']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'uuid': serializer.toJson<String>(uuid),
      'bookId': serializer.toJson<String>(bookId),
      'chapterId': serializer.toJson<int>(chapterId),
      'title': serializer.toJson<String>(title),
      'fingerprint': serializer.toJson<String?>(fingerprint),
      'urlSuffix': serializer.toJson<String?>(urlSuffix),
      'bytes': serializer.toJson<int>(bytes),
      'durationSec': serializer.toJson<double?>(durationSec),
      'peaks': serializer.toJson<String?>(peaks),
      'finished': serializer.toJson<bool>(finished),
    };
  }

  Chapter copyWith({
    String? uuid,
    String? bookId,
    int? chapterId,
    String? title,
    Value<String?> fingerprint = const Value.absent(),
    Value<String?> urlSuffix = const Value.absent(),
    int? bytes,
    Value<double?> durationSec = const Value.absent(),
    Value<String?> peaks = const Value.absent(),
    bool? finished,
  }) => Chapter(
    uuid: uuid ?? this.uuid,
    bookId: bookId ?? this.bookId,
    chapterId: chapterId ?? this.chapterId,
    title: title ?? this.title,
    fingerprint: fingerprint.present ? fingerprint.value : this.fingerprint,
    urlSuffix: urlSuffix.present ? urlSuffix.value : this.urlSuffix,
    bytes: bytes ?? this.bytes,
    durationSec: durationSec.present ? durationSec.value : this.durationSec,
    peaks: peaks.present ? peaks.value : this.peaks,
    finished: finished ?? this.finished,
  );
  Chapter copyWithCompanion(ChaptersCompanion data) {
    return Chapter(
      uuid: data.uuid.present ? data.uuid.value : this.uuid,
      bookId: data.bookId.present ? data.bookId.value : this.bookId,
      chapterId: data.chapterId.present ? data.chapterId.value : this.chapterId,
      title: data.title.present ? data.title.value : this.title,
      fingerprint: data.fingerprint.present
          ? data.fingerprint.value
          : this.fingerprint,
      urlSuffix: data.urlSuffix.present ? data.urlSuffix.value : this.urlSuffix,
      bytes: data.bytes.present ? data.bytes.value : this.bytes,
      durationSec: data.durationSec.present
          ? data.durationSec.value
          : this.durationSec,
      peaks: data.peaks.present ? data.peaks.value : this.peaks,
      finished: data.finished.present ? data.finished.value : this.finished,
    );
  }

  @override
  String toString() {
    return (StringBuffer('Chapter(')
          ..write('uuid: $uuid, ')
          ..write('bookId: $bookId, ')
          ..write('chapterId: $chapterId, ')
          ..write('title: $title, ')
          ..write('fingerprint: $fingerprint, ')
          ..write('urlSuffix: $urlSuffix, ')
          ..write('bytes: $bytes, ')
          ..write('durationSec: $durationSec, ')
          ..write('peaks: $peaks, ')
          ..write('finished: $finished')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    uuid,
    bookId,
    chapterId,
    title,
    fingerprint,
    urlSuffix,
    bytes,
    durationSec,
    peaks,
    finished,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is Chapter &&
          other.uuid == this.uuid &&
          other.bookId == this.bookId &&
          other.chapterId == this.chapterId &&
          other.title == this.title &&
          other.fingerprint == this.fingerprint &&
          other.urlSuffix == this.urlSuffix &&
          other.bytes == this.bytes &&
          other.durationSec == this.durationSec &&
          other.peaks == this.peaks &&
          other.finished == this.finished);
}

class ChaptersCompanion extends UpdateCompanion<Chapter> {
  final Value<String> uuid;
  final Value<String> bookId;
  final Value<int> chapterId;
  final Value<String> title;
  final Value<String?> fingerprint;
  final Value<String?> urlSuffix;
  final Value<int> bytes;
  final Value<double?> durationSec;
  final Value<String?> peaks;
  final Value<bool> finished;
  final Value<int> rowid;
  const ChaptersCompanion({
    this.uuid = const Value.absent(),
    this.bookId = const Value.absent(),
    this.chapterId = const Value.absent(),
    this.title = const Value.absent(),
    this.fingerprint = const Value.absent(),
    this.urlSuffix = const Value.absent(),
    this.bytes = const Value.absent(),
    this.durationSec = const Value.absent(),
    this.peaks = const Value.absent(),
    this.finished = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  ChaptersCompanion.insert({
    required String uuid,
    required String bookId,
    required int chapterId,
    this.title = const Value.absent(),
    this.fingerprint = const Value.absent(),
    this.urlSuffix = const Value.absent(),
    this.bytes = const Value.absent(),
    this.durationSec = const Value.absent(),
    this.peaks = const Value.absent(),
    this.finished = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : uuid = Value(uuid),
       bookId = Value(bookId),
       chapterId = Value(chapterId);
  static Insertable<Chapter> custom({
    Expression<String>? uuid,
    Expression<String>? bookId,
    Expression<int>? chapterId,
    Expression<String>? title,
    Expression<String>? fingerprint,
    Expression<String>? urlSuffix,
    Expression<int>? bytes,
    Expression<double>? durationSec,
    Expression<String>? peaks,
    Expression<bool>? finished,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (uuid != null) 'uuid': uuid,
      if (bookId != null) 'book_id': bookId,
      if (chapterId != null) 'chapter_id': chapterId,
      if (title != null) 'title': title,
      if (fingerprint != null) 'fingerprint': fingerprint,
      if (urlSuffix != null) 'url_suffix': urlSuffix,
      if (bytes != null) 'bytes': bytes,
      if (durationSec != null) 'duration_sec': durationSec,
      if (peaks != null) 'peaks': peaks,
      if (finished != null) 'finished': finished,
      if (rowid != null) 'rowid': rowid,
    });
  }

  ChaptersCompanion copyWith({
    Value<String>? uuid,
    Value<String>? bookId,
    Value<int>? chapterId,
    Value<String>? title,
    Value<String?>? fingerprint,
    Value<String?>? urlSuffix,
    Value<int>? bytes,
    Value<double?>? durationSec,
    Value<String?>? peaks,
    Value<bool>? finished,
    Value<int>? rowid,
  }) {
    return ChaptersCompanion(
      uuid: uuid ?? this.uuid,
      bookId: bookId ?? this.bookId,
      chapterId: chapterId ?? this.chapterId,
      title: title ?? this.title,
      fingerprint: fingerprint ?? this.fingerprint,
      urlSuffix: urlSuffix ?? this.urlSuffix,
      bytes: bytes ?? this.bytes,
      durationSec: durationSec ?? this.durationSec,
      peaks: peaks ?? this.peaks,
      finished: finished ?? this.finished,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (uuid.present) {
      map['uuid'] = Variable<String>(uuid.value);
    }
    if (bookId.present) {
      map['book_id'] = Variable<String>(bookId.value);
    }
    if (chapterId.present) {
      map['chapter_id'] = Variable<int>(chapterId.value);
    }
    if (title.present) {
      map['title'] = Variable<String>(title.value);
    }
    if (fingerprint.present) {
      map['fingerprint'] = Variable<String>(fingerprint.value);
    }
    if (urlSuffix.present) {
      map['url_suffix'] = Variable<String>(urlSuffix.value);
    }
    if (bytes.present) {
      map['bytes'] = Variable<int>(bytes.value);
    }
    if (durationSec.present) {
      map['duration_sec'] = Variable<double>(durationSec.value);
    }
    if (peaks.present) {
      map['peaks'] = Variable<String>(peaks.value);
    }
    if (finished.present) {
      map['finished'] = Variable<bool>(finished.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('ChaptersCompanion(')
          ..write('uuid: $uuid, ')
          ..write('bookId: $bookId, ')
          ..write('chapterId: $chapterId, ')
          ..write('title: $title, ')
          ..write('fingerprint: $fingerprint, ')
          ..write('urlSuffix: $urlSuffix, ')
          ..write('bytes: $bytes, ')
          ..write('durationSec: $durationSec, ')
          ..write('peaks: $peaks, ')
          ..write('finished: $finished, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $PlaybackTable extends Playback
    with TableInfo<$PlaybackTable, PlaybackData> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $PlaybackTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _bookIdMeta = const VerificationMeta('bookId');
  @override
  late final GeneratedColumn<String> bookId = GeneratedColumn<String>(
    'book_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _chapterUuidMeta = const VerificationMeta(
    'chapterUuid',
  );
  @override
  late final GeneratedColumn<String> chapterUuid = GeneratedColumn<String>(
    'chapter_uuid',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _positionMsMeta = const VerificationMeta(
    'positionMs',
  );
  @override
  late final GeneratedColumn<int> positionMs = GeneratedColumn<int>(
    'position_ms',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<String> updatedAt = GeneratedColumn<String>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  @override
  List<GeneratedColumn> get $columns => [
    bookId,
    chapterUuid,
    positionMs,
    updatedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'playback';
  @override
  VerificationContext validateIntegrity(
    Insertable<PlaybackData> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('book_id')) {
      context.handle(
        _bookIdMeta,
        bookId.isAcceptableOrUnknown(data['book_id']!, _bookIdMeta),
      );
    } else if (isInserting) {
      context.missing(_bookIdMeta);
    }
    if (data.containsKey('chapter_uuid')) {
      context.handle(
        _chapterUuidMeta,
        chapterUuid.isAcceptableOrUnknown(
          data['chapter_uuid']!,
          _chapterUuidMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_chapterUuidMeta);
    }
    if (data.containsKey('position_ms')) {
      context.handle(
        _positionMsMeta,
        positionMs.isAcceptableOrUnknown(data['position_ms']!, _positionMsMeta),
      );
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {bookId};
  @override
  PlaybackData map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return PlaybackData(
      bookId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}book_id'],
      )!,
      chapterUuid: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}chapter_uuid'],
      )!,
      positionMs: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}position_ms'],
      )!,
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}updated_at'],
      )!,
    );
  }

  @override
  $PlaybackTable createAlias(String alias) {
    return $PlaybackTable(attachedDatabase, alias);
  }
}

class PlaybackData extends DataClass implements Insertable<PlaybackData> {
  final String bookId;
  final String chapterUuid;
  final int positionMs;
  final String updatedAt;
  const PlaybackData({
    required this.bookId,
    required this.chapterUuid,
    required this.positionMs,
    required this.updatedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['book_id'] = Variable<String>(bookId);
    map['chapter_uuid'] = Variable<String>(chapterUuid);
    map['position_ms'] = Variable<int>(positionMs);
    map['updated_at'] = Variable<String>(updatedAt);
    return map;
  }

  PlaybackCompanion toCompanion(bool nullToAbsent) {
    return PlaybackCompanion(
      bookId: Value(bookId),
      chapterUuid: Value(chapterUuid),
      positionMs: Value(positionMs),
      updatedAt: Value(updatedAt),
    );
  }

  factory PlaybackData.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return PlaybackData(
      bookId: serializer.fromJson<String>(json['bookId']),
      chapterUuid: serializer.fromJson<String>(json['chapterUuid']),
      positionMs: serializer.fromJson<int>(json['positionMs']),
      updatedAt: serializer.fromJson<String>(json['updatedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'bookId': serializer.toJson<String>(bookId),
      'chapterUuid': serializer.toJson<String>(chapterUuid),
      'positionMs': serializer.toJson<int>(positionMs),
      'updatedAt': serializer.toJson<String>(updatedAt),
    };
  }

  PlaybackData copyWith({
    String? bookId,
    String? chapterUuid,
    int? positionMs,
    String? updatedAt,
  }) => PlaybackData(
    bookId: bookId ?? this.bookId,
    chapterUuid: chapterUuid ?? this.chapterUuid,
    positionMs: positionMs ?? this.positionMs,
    updatedAt: updatedAt ?? this.updatedAt,
  );
  PlaybackData copyWithCompanion(PlaybackCompanion data) {
    return PlaybackData(
      bookId: data.bookId.present ? data.bookId.value : this.bookId,
      chapterUuid: data.chapterUuid.present
          ? data.chapterUuid.value
          : this.chapterUuid,
      positionMs: data.positionMs.present
          ? data.positionMs.value
          : this.positionMs,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('PlaybackData(')
          ..write('bookId: $bookId, ')
          ..write('chapterUuid: $chapterUuid, ')
          ..write('positionMs: $positionMs, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(bookId, chapterUuid, positionMs, updatedAt);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is PlaybackData &&
          other.bookId == this.bookId &&
          other.chapterUuid == this.chapterUuid &&
          other.positionMs == this.positionMs &&
          other.updatedAt == this.updatedAt);
}

class PlaybackCompanion extends UpdateCompanion<PlaybackData> {
  final Value<String> bookId;
  final Value<String> chapterUuid;
  final Value<int> positionMs;
  final Value<String> updatedAt;
  final Value<int> rowid;
  const PlaybackCompanion({
    this.bookId = const Value.absent(),
    this.chapterUuid = const Value.absent(),
    this.positionMs = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  PlaybackCompanion.insert({
    required String bookId,
    required String chapterUuid,
    this.positionMs = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : bookId = Value(bookId),
       chapterUuid = Value(chapterUuid);
  static Insertable<PlaybackData> custom({
    Expression<String>? bookId,
    Expression<String>? chapterUuid,
    Expression<int>? positionMs,
    Expression<String>? updatedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (bookId != null) 'book_id': bookId,
      if (chapterUuid != null) 'chapter_uuid': chapterUuid,
      if (positionMs != null) 'position_ms': positionMs,
      if (updatedAt != null) 'updated_at': updatedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  PlaybackCompanion copyWith({
    Value<String>? bookId,
    Value<String>? chapterUuid,
    Value<int>? positionMs,
    Value<String>? updatedAt,
    Value<int>? rowid,
  }) {
    return PlaybackCompanion(
      bookId: bookId ?? this.bookId,
      chapterUuid: chapterUuid ?? this.chapterUuid,
      positionMs: positionMs ?? this.positionMs,
      updatedAt: updatedAt ?? this.updatedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (bookId.present) {
      map['book_id'] = Variable<String>(bookId.value);
    }
    if (chapterUuid.present) {
      map['chapter_uuid'] = Variable<String>(chapterUuid.value);
    }
    if (positionMs.present) {
      map['position_ms'] = Variable<int>(positionMs.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<String>(updatedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('PlaybackCompanion(')
          ..write('bookId: $bookId, ')
          ..write('chapterUuid: $chapterUuid, ')
          ..write('positionMs: $positionMs, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $ListenStatsBufferTable extends ListenStatsBuffer
    with TableInfo<$ListenStatsBufferTable, ListenStatsBufferData> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $ListenStatsBufferTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _sessionIdMeta = const VerificationMeta(
    'sessionId',
  );
  @override
  late final GeneratedColumn<String> sessionId = GeneratedColumn<String>(
    'session_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _bookIdMeta = const VerificationMeta('bookId');
  @override
  late final GeneratedColumn<String> bookId = GeneratedColumn<String>(
    'book_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _dateMeta = const VerificationMeta('date');
  @override
  late final GeneratedColumn<String> date = GeneratedColumn<String>(
    'date',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _secondsMeta = const VerificationMeta(
    'seconds',
  );
  @override
  late final GeneratedColumn<int> seconds = GeneratedColumn<int>(
    'seconds',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [sessionId, bookId, date, seconds];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'listen_stats_buffer';
  @override
  VerificationContext validateIntegrity(
    Insertable<ListenStatsBufferData> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('session_id')) {
      context.handle(
        _sessionIdMeta,
        sessionId.isAcceptableOrUnknown(data['session_id']!, _sessionIdMeta),
      );
    } else if (isInserting) {
      context.missing(_sessionIdMeta);
    }
    if (data.containsKey('book_id')) {
      context.handle(
        _bookIdMeta,
        bookId.isAcceptableOrUnknown(data['book_id']!, _bookIdMeta),
      );
    } else if (isInserting) {
      context.missing(_bookIdMeta);
    }
    if (data.containsKey('date')) {
      context.handle(
        _dateMeta,
        date.isAcceptableOrUnknown(data['date']!, _dateMeta),
      );
    } else if (isInserting) {
      context.missing(_dateMeta);
    }
    if (data.containsKey('seconds')) {
      context.handle(
        _secondsMeta,
        seconds.isAcceptableOrUnknown(data['seconds']!, _secondsMeta),
      );
    } else if (isInserting) {
      context.missing(_secondsMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {sessionId, bookId, date};
  @override
  ListenStatsBufferData map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return ListenStatsBufferData(
      sessionId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}session_id'],
      )!,
      bookId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}book_id'],
      )!,
      date: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}date'],
      )!,
      seconds: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}seconds'],
      )!,
    );
  }

  @override
  $ListenStatsBufferTable createAlias(String alias) {
    return $ListenStatsBufferTable(attachedDatabase, alias);
  }
}

class ListenStatsBufferData extends DataClass
    implements Insertable<ListenStatsBufferData> {
  final String sessionId;
  final String bookId;
  final String date;
  final int seconds;
  const ListenStatsBufferData({
    required this.sessionId,
    required this.bookId,
    required this.date,
    required this.seconds,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['session_id'] = Variable<String>(sessionId);
    map['book_id'] = Variable<String>(bookId);
    map['date'] = Variable<String>(date);
    map['seconds'] = Variable<int>(seconds);
    return map;
  }

  ListenStatsBufferCompanion toCompanion(bool nullToAbsent) {
    return ListenStatsBufferCompanion(
      sessionId: Value(sessionId),
      bookId: Value(bookId),
      date: Value(date),
      seconds: Value(seconds),
    );
  }

  factory ListenStatsBufferData.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return ListenStatsBufferData(
      sessionId: serializer.fromJson<String>(json['sessionId']),
      bookId: serializer.fromJson<String>(json['bookId']),
      date: serializer.fromJson<String>(json['date']),
      seconds: serializer.fromJson<int>(json['seconds']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'sessionId': serializer.toJson<String>(sessionId),
      'bookId': serializer.toJson<String>(bookId),
      'date': serializer.toJson<String>(date),
      'seconds': serializer.toJson<int>(seconds),
    };
  }

  ListenStatsBufferData copyWith({
    String? sessionId,
    String? bookId,
    String? date,
    int? seconds,
  }) => ListenStatsBufferData(
    sessionId: sessionId ?? this.sessionId,
    bookId: bookId ?? this.bookId,
    date: date ?? this.date,
    seconds: seconds ?? this.seconds,
  );
  ListenStatsBufferData copyWithCompanion(ListenStatsBufferCompanion data) {
    return ListenStatsBufferData(
      sessionId: data.sessionId.present ? data.sessionId.value : this.sessionId,
      bookId: data.bookId.present ? data.bookId.value : this.bookId,
      date: data.date.present ? data.date.value : this.date,
      seconds: data.seconds.present ? data.seconds.value : this.seconds,
    );
  }

  @override
  String toString() {
    return (StringBuffer('ListenStatsBufferData(')
          ..write('sessionId: $sessionId, ')
          ..write('bookId: $bookId, ')
          ..write('date: $date, ')
          ..write('seconds: $seconds')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(sessionId, bookId, date, seconds);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is ListenStatsBufferData &&
          other.sessionId == this.sessionId &&
          other.bookId == this.bookId &&
          other.date == this.date &&
          other.seconds == this.seconds);
}

class ListenStatsBufferCompanion
    extends UpdateCompanion<ListenStatsBufferData> {
  final Value<String> sessionId;
  final Value<String> bookId;
  final Value<String> date;
  final Value<int> seconds;
  final Value<int> rowid;
  const ListenStatsBufferCompanion({
    this.sessionId = const Value.absent(),
    this.bookId = const Value.absent(),
    this.date = const Value.absent(),
    this.seconds = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  ListenStatsBufferCompanion.insert({
    required String sessionId,
    required String bookId,
    required String date,
    required int seconds,
    this.rowid = const Value.absent(),
  }) : sessionId = Value(sessionId),
       bookId = Value(bookId),
       date = Value(date),
       seconds = Value(seconds);
  static Insertable<ListenStatsBufferData> custom({
    Expression<String>? sessionId,
    Expression<String>? bookId,
    Expression<String>? date,
    Expression<int>? seconds,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (sessionId != null) 'session_id': sessionId,
      if (bookId != null) 'book_id': bookId,
      if (date != null) 'date': date,
      if (seconds != null) 'seconds': seconds,
      if (rowid != null) 'rowid': rowid,
    });
  }

  ListenStatsBufferCompanion copyWith({
    Value<String>? sessionId,
    Value<String>? bookId,
    Value<String>? date,
    Value<int>? seconds,
    Value<int>? rowid,
  }) {
    return ListenStatsBufferCompanion(
      sessionId: sessionId ?? this.sessionId,
      bookId: bookId ?? this.bookId,
      date: date ?? this.date,
      seconds: seconds ?? this.seconds,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (sessionId.present) {
      map['session_id'] = Variable<String>(sessionId.value);
    }
    if (bookId.present) {
      map['book_id'] = Variable<String>(bookId.value);
    }
    if (date.present) {
      map['date'] = Variable<String>(date.value);
    }
    if (seconds.present) {
      map['seconds'] = Variable<int>(seconds.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('ListenStatsBufferCompanion(')
          ..write('sessionId: $sessionId, ')
          ..write('bookId: $bookId, ')
          ..write('date: $date, ')
          ..write('seconds: $seconds, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

abstract class _$LibraryDatabase extends GeneratedDatabase {
  _$LibraryDatabase(QueryExecutor e) : super(e);
  $LibraryDatabaseManager get managers => $LibraryDatabaseManager(this);
  late final $BooksTable books = $BooksTable(this);
  late final $ChaptersTable chapters = $ChaptersTable(this);
  late final $PlaybackTable playback = $PlaybackTable(this);
  late final $ListenStatsBufferTable listenStatsBuffer =
      $ListenStatsBufferTable(this);
  @override
  Iterable<TableInfo<Table, Object?>> get allTables =>
      allSchemaEntities.whereType<TableInfo<Table, Object?>>();
  @override
  List<DatabaseSchemaEntity> get allSchemaEntities => [
    books,
    chapters,
    playback,
    listenStatsBuffer,
  ];
}

typedef $$BooksTableCreateCompanionBuilder =
    BooksCompanion Function({
      required String bookId,
      Value<String> updatedAt,
      Value<String> title,
      Value<String> author,
      Value<String> series,
      Value<int?> seriesPosition,
      Value<String?> lastPlayedAt,
      Value<String?> coverThumbPath,
      Value<int> rowid,
    });
typedef $$BooksTableUpdateCompanionBuilder =
    BooksCompanion Function({
      Value<String> bookId,
      Value<String> updatedAt,
      Value<String> title,
      Value<String> author,
      Value<String> series,
      Value<int?> seriesPosition,
      Value<String?> lastPlayedAt,
      Value<String?> coverThumbPath,
      Value<int> rowid,
    });

class $$BooksTableFilterComposer
    extends Composer<_$LibraryDatabase, $BooksTable> {
  $$BooksTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get bookId => $composableBuilder(
    column: $table.bookId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get title => $composableBuilder(
    column: $table.title,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get author => $composableBuilder(
    column: $table.author,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get series => $composableBuilder(
    column: $table.series,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get seriesPosition => $composableBuilder(
    column: $table.seriesPosition,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get lastPlayedAt => $composableBuilder(
    column: $table.lastPlayedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get coverThumbPath => $composableBuilder(
    column: $table.coverThumbPath,
    builder: (column) => ColumnFilters(column),
  );
}

class $$BooksTableOrderingComposer
    extends Composer<_$LibraryDatabase, $BooksTable> {
  $$BooksTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get bookId => $composableBuilder(
    column: $table.bookId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get title => $composableBuilder(
    column: $table.title,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get author => $composableBuilder(
    column: $table.author,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get series => $composableBuilder(
    column: $table.series,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get seriesPosition => $composableBuilder(
    column: $table.seriesPosition,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get lastPlayedAt => $composableBuilder(
    column: $table.lastPlayedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get coverThumbPath => $composableBuilder(
    column: $table.coverThumbPath,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$BooksTableAnnotationComposer
    extends Composer<_$LibraryDatabase, $BooksTable> {
  $$BooksTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get bookId =>
      $composableBuilder(column: $table.bookId, builder: (column) => column);

  GeneratedColumn<String> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);

  GeneratedColumn<String> get title =>
      $composableBuilder(column: $table.title, builder: (column) => column);

  GeneratedColumn<String> get author =>
      $composableBuilder(column: $table.author, builder: (column) => column);

  GeneratedColumn<String> get series =>
      $composableBuilder(column: $table.series, builder: (column) => column);

  GeneratedColumn<int> get seriesPosition => $composableBuilder(
    column: $table.seriesPosition,
    builder: (column) => column,
  );

  GeneratedColumn<String> get lastPlayedAt => $composableBuilder(
    column: $table.lastPlayedAt,
    builder: (column) => column,
  );

  GeneratedColumn<String> get coverThumbPath => $composableBuilder(
    column: $table.coverThumbPath,
    builder: (column) => column,
  );
}

class $$BooksTableTableManager
    extends
        RootTableManager<
          _$LibraryDatabase,
          $BooksTable,
          Book,
          $$BooksTableFilterComposer,
          $$BooksTableOrderingComposer,
          $$BooksTableAnnotationComposer,
          $$BooksTableCreateCompanionBuilder,
          $$BooksTableUpdateCompanionBuilder,
          (Book, BaseReferences<_$LibraryDatabase, $BooksTable, Book>),
          Book,
          PrefetchHooks Function()
        > {
  $$BooksTableTableManager(_$LibraryDatabase db, $BooksTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$BooksTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$BooksTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$BooksTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> bookId = const Value.absent(),
                Value<String> updatedAt = const Value.absent(),
                Value<String> title = const Value.absent(),
                Value<String> author = const Value.absent(),
                Value<String> series = const Value.absent(),
                Value<int?> seriesPosition = const Value.absent(),
                Value<String?> lastPlayedAt = const Value.absent(),
                Value<String?> coverThumbPath = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => BooksCompanion(
                bookId: bookId,
                updatedAt: updatedAt,
                title: title,
                author: author,
                series: series,
                seriesPosition: seriesPosition,
                lastPlayedAt: lastPlayedAt,
                coverThumbPath: coverThumbPath,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String bookId,
                Value<String> updatedAt = const Value.absent(),
                Value<String> title = const Value.absent(),
                Value<String> author = const Value.absent(),
                Value<String> series = const Value.absent(),
                Value<int?> seriesPosition = const Value.absent(),
                Value<String?> lastPlayedAt = const Value.absent(),
                Value<String?> coverThumbPath = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => BooksCompanion.insert(
                bookId: bookId,
                updatedAt: updatedAt,
                title: title,
                author: author,
                series: series,
                seriesPosition: seriesPosition,
                lastPlayedAt: lastPlayedAt,
                coverThumbPath: coverThumbPath,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$BooksTableProcessedTableManager =
    ProcessedTableManager<
      _$LibraryDatabase,
      $BooksTable,
      Book,
      $$BooksTableFilterComposer,
      $$BooksTableOrderingComposer,
      $$BooksTableAnnotationComposer,
      $$BooksTableCreateCompanionBuilder,
      $$BooksTableUpdateCompanionBuilder,
      (Book, BaseReferences<_$LibraryDatabase, $BooksTable, Book>),
      Book,
      PrefetchHooks Function()
    >;
typedef $$ChaptersTableCreateCompanionBuilder =
    ChaptersCompanion Function({
      required String uuid,
      required String bookId,
      required int chapterId,
      Value<String> title,
      Value<String?> fingerprint,
      Value<String?> urlSuffix,
      Value<int> bytes,
      Value<double?> durationSec,
      Value<String?> peaks,
      Value<bool> finished,
      Value<int> rowid,
    });
typedef $$ChaptersTableUpdateCompanionBuilder =
    ChaptersCompanion Function({
      Value<String> uuid,
      Value<String> bookId,
      Value<int> chapterId,
      Value<String> title,
      Value<String?> fingerprint,
      Value<String?> urlSuffix,
      Value<int> bytes,
      Value<double?> durationSec,
      Value<String?> peaks,
      Value<bool> finished,
      Value<int> rowid,
    });

class $$ChaptersTableFilterComposer
    extends Composer<_$LibraryDatabase, $ChaptersTable> {
  $$ChaptersTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get uuid => $composableBuilder(
    column: $table.uuid,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get bookId => $composableBuilder(
    column: $table.bookId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get chapterId => $composableBuilder(
    column: $table.chapterId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get title => $composableBuilder(
    column: $table.title,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get fingerprint => $composableBuilder(
    column: $table.fingerprint,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get urlSuffix => $composableBuilder(
    column: $table.urlSuffix,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get bytes => $composableBuilder(
    column: $table.bytes,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get durationSec => $composableBuilder(
    column: $table.durationSec,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get peaks => $composableBuilder(
    column: $table.peaks,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<bool> get finished => $composableBuilder(
    column: $table.finished,
    builder: (column) => ColumnFilters(column),
  );
}

class $$ChaptersTableOrderingComposer
    extends Composer<_$LibraryDatabase, $ChaptersTable> {
  $$ChaptersTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get uuid => $composableBuilder(
    column: $table.uuid,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get bookId => $composableBuilder(
    column: $table.bookId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get chapterId => $composableBuilder(
    column: $table.chapterId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get title => $composableBuilder(
    column: $table.title,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get fingerprint => $composableBuilder(
    column: $table.fingerprint,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get urlSuffix => $composableBuilder(
    column: $table.urlSuffix,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get bytes => $composableBuilder(
    column: $table.bytes,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get durationSec => $composableBuilder(
    column: $table.durationSec,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get peaks => $composableBuilder(
    column: $table.peaks,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<bool> get finished => $composableBuilder(
    column: $table.finished,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$ChaptersTableAnnotationComposer
    extends Composer<_$LibraryDatabase, $ChaptersTable> {
  $$ChaptersTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get uuid =>
      $composableBuilder(column: $table.uuid, builder: (column) => column);

  GeneratedColumn<String> get bookId =>
      $composableBuilder(column: $table.bookId, builder: (column) => column);

  GeneratedColumn<int> get chapterId =>
      $composableBuilder(column: $table.chapterId, builder: (column) => column);

  GeneratedColumn<String> get title =>
      $composableBuilder(column: $table.title, builder: (column) => column);

  GeneratedColumn<String> get fingerprint => $composableBuilder(
    column: $table.fingerprint,
    builder: (column) => column,
  );

  GeneratedColumn<String> get urlSuffix =>
      $composableBuilder(column: $table.urlSuffix, builder: (column) => column);

  GeneratedColumn<int> get bytes =>
      $composableBuilder(column: $table.bytes, builder: (column) => column);

  GeneratedColumn<double> get durationSec => $composableBuilder(
    column: $table.durationSec,
    builder: (column) => column,
  );

  GeneratedColumn<String> get peaks =>
      $composableBuilder(column: $table.peaks, builder: (column) => column);

  GeneratedColumn<bool> get finished =>
      $composableBuilder(column: $table.finished, builder: (column) => column);
}

class $$ChaptersTableTableManager
    extends
        RootTableManager<
          _$LibraryDatabase,
          $ChaptersTable,
          Chapter,
          $$ChaptersTableFilterComposer,
          $$ChaptersTableOrderingComposer,
          $$ChaptersTableAnnotationComposer,
          $$ChaptersTableCreateCompanionBuilder,
          $$ChaptersTableUpdateCompanionBuilder,
          (Chapter, BaseReferences<_$LibraryDatabase, $ChaptersTable, Chapter>),
          Chapter,
          PrefetchHooks Function()
        > {
  $$ChaptersTableTableManager(_$LibraryDatabase db, $ChaptersTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$ChaptersTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$ChaptersTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$ChaptersTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> uuid = const Value.absent(),
                Value<String> bookId = const Value.absent(),
                Value<int> chapterId = const Value.absent(),
                Value<String> title = const Value.absent(),
                Value<String?> fingerprint = const Value.absent(),
                Value<String?> urlSuffix = const Value.absent(),
                Value<int> bytes = const Value.absent(),
                Value<double?> durationSec = const Value.absent(),
                Value<String?> peaks = const Value.absent(),
                Value<bool> finished = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => ChaptersCompanion(
                uuid: uuid,
                bookId: bookId,
                chapterId: chapterId,
                title: title,
                fingerprint: fingerprint,
                urlSuffix: urlSuffix,
                bytes: bytes,
                durationSec: durationSec,
                peaks: peaks,
                finished: finished,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String uuid,
                required String bookId,
                required int chapterId,
                Value<String> title = const Value.absent(),
                Value<String?> fingerprint = const Value.absent(),
                Value<String?> urlSuffix = const Value.absent(),
                Value<int> bytes = const Value.absent(),
                Value<double?> durationSec = const Value.absent(),
                Value<String?> peaks = const Value.absent(),
                Value<bool> finished = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => ChaptersCompanion.insert(
                uuid: uuid,
                bookId: bookId,
                chapterId: chapterId,
                title: title,
                fingerprint: fingerprint,
                urlSuffix: urlSuffix,
                bytes: bytes,
                durationSec: durationSec,
                peaks: peaks,
                finished: finished,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$ChaptersTableProcessedTableManager =
    ProcessedTableManager<
      _$LibraryDatabase,
      $ChaptersTable,
      Chapter,
      $$ChaptersTableFilterComposer,
      $$ChaptersTableOrderingComposer,
      $$ChaptersTableAnnotationComposer,
      $$ChaptersTableCreateCompanionBuilder,
      $$ChaptersTableUpdateCompanionBuilder,
      (Chapter, BaseReferences<_$LibraryDatabase, $ChaptersTable, Chapter>),
      Chapter,
      PrefetchHooks Function()
    >;
typedef $$PlaybackTableCreateCompanionBuilder =
    PlaybackCompanion Function({
      required String bookId,
      required String chapterUuid,
      Value<int> positionMs,
      Value<String> updatedAt,
      Value<int> rowid,
    });
typedef $$PlaybackTableUpdateCompanionBuilder =
    PlaybackCompanion Function({
      Value<String> bookId,
      Value<String> chapterUuid,
      Value<int> positionMs,
      Value<String> updatedAt,
      Value<int> rowid,
    });

class $$PlaybackTableFilterComposer
    extends Composer<_$LibraryDatabase, $PlaybackTable> {
  $$PlaybackTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get bookId => $composableBuilder(
    column: $table.bookId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get chapterUuid => $composableBuilder(
    column: $table.chapterUuid,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get positionMs => $composableBuilder(
    column: $table.positionMs,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$PlaybackTableOrderingComposer
    extends Composer<_$LibraryDatabase, $PlaybackTable> {
  $$PlaybackTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get bookId => $composableBuilder(
    column: $table.bookId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get chapterUuid => $composableBuilder(
    column: $table.chapterUuid,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get positionMs => $composableBuilder(
    column: $table.positionMs,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$PlaybackTableAnnotationComposer
    extends Composer<_$LibraryDatabase, $PlaybackTable> {
  $$PlaybackTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get bookId =>
      $composableBuilder(column: $table.bookId, builder: (column) => column);

  GeneratedColumn<String> get chapterUuid => $composableBuilder(
    column: $table.chapterUuid,
    builder: (column) => column,
  );

  GeneratedColumn<int> get positionMs => $composableBuilder(
    column: $table.positionMs,
    builder: (column) => column,
  );

  GeneratedColumn<String> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);
}

class $$PlaybackTableTableManager
    extends
        RootTableManager<
          _$LibraryDatabase,
          $PlaybackTable,
          PlaybackData,
          $$PlaybackTableFilterComposer,
          $$PlaybackTableOrderingComposer,
          $$PlaybackTableAnnotationComposer,
          $$PlaybackTableCreateCompanionBuilder,
          $$PlaybackTableUpdateCompanionBuilder,
          (
            PlaybackData,
            BaseReferences<_$LibraryDatabase, $PlaybackTable, PlaybackData>,
          ),
          PlaybackData,
          PrefetchHooks Function()
        > {
  $$PlaybackTableTableManager(_$LibraryDatabase db, $PlaybackTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$PlaybackTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$PlaybackTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$PlaybackTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> bookId = const Value.absent(),
                Value<String> chapterUuid = const Value.absent(),
                Value<int> positionMs = const Value.absent(),
                Value<String> updatedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => PlaybackCompanion(
                bookId: bookId,
                chapterUuid: chapterUuid,
                positionMs: positionMs,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String bookId,
                required String chapterUuid,
                Value<int> positionMs = const Value.absent(),
                Value<String> updatedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => PlaybackCompanion.insert(
                bookId: bookId,
                chapterUuid: chapterUuid,
                positionMs: positionMs,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$PlaybackTableProcessedTableManager =
    ProcessedTableManager<
      _$LibraryDatabase,
      $PlaybackTable,
      PlaybackData,
      $$PlaybackTableFilterComposer,
      $$PlaybackTableOrderingComposer,
      $$PlaybackTableAnnotationComposer,
      $$PlaybackTableCreateCompanionBuilder,
      $$PlaybackTableUpdateCompanionBuilder,
      (
        PlaybackData,
        BaseReferences<_$LibraryDatabase, $PlaybackTable, PlaybackData>,
      ),
      PlaybackData,
      PrefetchHooks Function()
    >;
typedef $$ListenStatsBufferTableCreateCompanionBuilder =
    ListenStatsBufferCompanion Function({
      required String sessionId,
      required String bookId,
      required String date,
      required int seconds,
      Value<int> rowid,
    });
typedef $$ListenStatsBufferTableUpdateCompanionBuilder =
    ListenStatsBufferCompanion Function({
      Value<String> sessionId,
      Value<String> bookId,
      Value<String> date,
      Value<int> seconds,
      Value<int> rowid,
    });

class $$ListenStatsBufferTableFilterComposer
    extends Composer<_$LibraryDatabase, $ListenStatsBufferTable> {
  $$ListenStatsBufferTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get bookId => $composableBuilder(
    column: $table.bookId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get date => $composableBuilder(
    column: $table.date,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get seconds => $composableBuilder(
    column: $table.seconds,
    builder: (column) => ColumnFilters(column),
  );
}

class $$ListenStatsBufferTableOrderingComposer
    extends Composer<_$LibraryDatabase, $ListenStatsBufferTable> {
  $$ListenStatsBufferTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get bookId => $composableBuilder(
    column: $table.bookId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get date => $composableBuilder(
    column: $table.date,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get seconds => $composableBuilder(
    column: $table.seconds,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$ListenStatsBufferTableAnnotationComposer
    extends Composer<_$LibraryDatabase, $ListenStatsBufferTable> {
  $$ListenStatsBufferTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get sessionId =>
      $composableBuilder(column: $table.sessionId, builder: (column) => column);

  GeneratedColumn<String> get bookId =>
      $composableBuilder(column: $table.bookId, builder: (column) => column);

  GeneratedColumn<String> get date =>
      $composableBuilder(column: $table.date, builder: (column) => column);

  GeneratedColumn<int> get seconds =>
      $composableBuilder(column: $table.seconds, builder: (column) => column);
}

class $$ListenStatsBufferTableTableManager
    extends
        RootTableManager<
          _$LibraryDatabase,
          $ListenStatsBufferTable,
          ListenStatsBufferData,
          $$ListenStatsBufferTableFilterComposer,
          $$ListenStatsBufferTableOrderingComposer,
          $$ListenStatsBufferTableAnnotationComposer,
          $$ListenStatsBufferTableCreateCompanionBuilder,
          $$ListenStatsBufferTableUpdateCompanionBuilder,
          (
            ListenStatsBufferData,
            BaseReferences<
              _$LibraryDatabase,
              $ListenStatsBufferTable,
              ListenStatsBufferData
            >,
          ),
          ListenStatsBufferData,
          PrefetchHooks Function()
        > {
  $$ListenStatsBufferTableTableManager(
    _$LibraryDatabase db,
    $ListenStatsBufferTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$ListenStatsBufferTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$ListenStatsBufferTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$ListenStatsBufferTableAnnotationComposer(
                $db: db,
                $table: table,
              ),
          updateCompanionCallback:
              ({
                Value<String> sessionId = const Value.absent(),
                Value<String> bookId = const Value.absent(),
                Value<String> date = const Value.absent(),
                Value<int> seconds = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => ListenStatsBufferCompanion(
                sessionId: sessionId,
                bookId: bookId,
                date: date,
                seconds: seconds,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String sessionId,
                required String bookId,
                required String date,
                required int seconds,
                Value<int> rowid = const Value.absent(),
              }) => ListenStatsBufferCompanion.insert(
                sessionId: sessionId,
                bookId: bookId,
                date: date,
                seconds: seconds,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$ListenStatsBufferTableProcessedTableManager =
    ProcessedTableManager<
      _$LibraryDatabase,
      $ListenStatsBufferTable,
      ListenStatsBufferData,
      $$ListenStatsBufferTableFilterComposer,
      $$ListenStatsBufferTableOrderingComposer,
      $$ListenStatsBufferTableAnnotationComposer,
      $$ListenStatsBufferTableCreateCompanionBuilder,
      $$ListenStatsBufferTableUpdateCompanionBuilder,
      (
        ListenStatsBufferData,
        BaseReferences<
          _$LibraryDatabase,
          $ListenStatsBufferTable,
          ListenStatsBufferData
        >,
      ),
      ListenStatsBufferData,
      PrefetchHooks Function()
    >;

class $LibraryDatabaseManager {
  final _$LibraryDatabase _db;
  $LibraryDatabaseManager(this._db);
  $$BooksTableTableManager get books =>
      $$BooksTableTableManager(_db, _db.books);
  $$ChaptersTableTableManager get chapters =>
      $$ChaptersTableTableManager(_db, _db.chapters);
  $$PlaybackTableTableManager get playback =>
      $$PlaybackTableTableManager(_db, _db.playback);
  $$ListenStatsBufferTableTableManager get listenStatsBuffer =>
      $$ListenStatsBufferTableTableManager(_db, _db.listenStatsBuffer);
}
