/** Turn a rejected settings save (`… failed (400): {"error":…,"issues":[…]}`,
    the shape realPutUserSettings and the endpoint routes throw) into the
    server's own validation messages. */
export function settingsIssueMessages(message: string): string[] {
  const start = message.indexOf('{');
  if (start >= 0) {
    try {
      const body = JSON.parse(message.slice(start)) as { error?: string; issues?: Array<{ message?: string }> };
      const issues = (body.issues ?? []).map((i) => i.message).filter((m): m is string => typeof m === 'string' && m.length > 0);
      if (issues.length > 0) return issues;
      if (body.error) return [body.error];
    } catch {
      /* not a JSON body — fall through to the raw message */
    }
  }
  return message ? [message] : [];
}
