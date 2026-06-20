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
  final cmp = DateTime.parse(localListenedAt).toUtc().compareTo(DateTime.parse(remoteUpdatedAt).toUtc());
  if (cmp > 0) return ResumeAction.pushLocal;
  if (cmp < 0) return ResumeAction.pullRemote;
  return ResumeAction.noop;
}
