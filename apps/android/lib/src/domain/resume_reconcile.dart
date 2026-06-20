/// Pure two-way resume conflict resolution (`app-6`). Last-write-wins by the
/// client listen time — the position made *latest in wall-clock listen time*
/// wins, not the one delivered latest over the network (the `srv-34` fix).
///
/// (Open nuance noted in plan 188: position isn't monotonic in time — a
/// "furthest position" tie-break could be layered on later; LWW-by-listen-time
/// is the v1 default.)
library;

enum ResumeAction { pushLocal, pullRemote, noop }

ResumeAction reconcileResume({
  required String? localListenedAt,
  required String? remoteUpdatedAt,
}) {
  if (localListenedAt == null && remoteUpdatedAt == null) return ResumeAction.noop;
  if (remoteUpdatedAt == null) return ResumeAction.pushLocal;
  if (localListenedAt == null) return ResumeAction.pullRemote;
  // FIX 2: guard against empty or malformed timestamps on either side.
  // An unparseable stamp (empty string, 'not-a-date', etc.) degrades to noop
  // rather than throwing FormatException and aborting the whole syncAll loop.
  if (remoteUpdatedAt.isEmpty || localListenedAt.isEmpty) return ResumeAction.noop;
  final DateTime localDt;
  final DateTime remoteDt;
  try {
    localDt = DateTime.parse(localListenedAt).toUtc();
    remoteDt = DateTime.parse(remoteUpdatedAt).toUtc();
  } on FormatException {
    return ResumeAction.noop;
  }
  final cmp = localDt.compareTo(remoteDt);
  if (cmp > 0) return ResumeAction.pushLocal;
  if (cmp < 0) return ResumeAction.pullRemote;
  return ResumeAction.noop;
}
