setImmediate(() => {
  throw new Error('boom at C:\\secret\\path');
});
