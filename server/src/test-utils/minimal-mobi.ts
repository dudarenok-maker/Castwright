/* Builds a minimal REAL legacy MOBI (PalmDOC, uncompressed, one text record,
   empty EXTH) that @lingo-reader/mobi-parser accepts, so a test can send an
   actual MOBI through the parse worker (the mobi library cannot be vi.mock'ed
   across a thread boundary). The single record carries `html` verbatim. */
export function buildMinimalMobi(html: string): Buffer {
  const text = Buffer.from(html, 'utf8');
  const title = Buffer.from('Test Book', 'utf8');
  const mobiHdrLen = 0xe8;
  const exthLen = 12;
  const rec0 = Buffer.alloc(16 + mobiHdrLen + exthLen + title.length + 2);
  // PalmDOC header: no compression, text length, one text record.
  rec0.writeUInt16BE(1, 0);
  rec0.writeUInt32BE(text.length, 4);
  rec0.writeUInt16BE(1, 8);
  rec0.writeUInt16BE(4096, 10);
  rec0.writeUInt16BE(0, 12); // encryption: none
  // MOBI header, offsets absolute within record 0.
  rec0.write('MOBI', 16);
  rec0.writeUInt32BE(mobiHdrLen, 20);
  rec0.writeUInt32BE(2, 24);
  rec0.writeUInt32BE(65001, 28); // utf-8
  rec0.writeUInt32BE(1, 32);
  rec0.writeUInt32BE(6, 36); // version (< 8: legacy MOBI, not KF8)
  rec0.writeUInt32BE(16 + mobiHdrLen + exthLen, 84); // title offset
  rec0.writeUInt32BE(title.length, 88);
  rec0.writeUInt32BE(2, 108); // resource start
  rec0.writeUInt32BE(0xffffffff, 112);
  rec0.writeUInt32BE(0x40, 128); // EXTH present
  rec0.writeUInt32BE(0xffffffff, 244);
  rec0.write('EXTH', 16 + mobiHdrLen);
  rec0.writeUInt32BE(exthLen, 16 + mobiHdrLen + 4);
  title.copy(rec0, 16 + mobiHdrLen + exthLen);
  const records = [rec0, text];
  const pdb = Buffer.alloc(78 + records.length * 8 + 2);
  pdb.write('TestBook', 0);
  pdb.write('BOOK', 60);
  pdb.write('MOBI', 64);
  pdb.writeUInt16BE(records.length, 76);
  let offset = pdb.length;
  records.forEach((r, i) => {
    pdb.writeUInt32BE(offset, 78 + i * 8);
    pdb.writeUInt32BE(2 * i, 78 + i * 8 + 4);
    offset += r.length;
  });
  return Buffer.concat([pdb, ...records]);
}
