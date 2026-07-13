/* Pure, testable core for slim-epub-cover: given an epub buffer and the bytes
   of a resized JPG cover, return a new epub buffer whose embedded cover image
   is swapped to that JPG. EVERY other entry — crucially the content HTML the
   attribution/parse is keyed to — is preserved byte-for-byte, so slimming a
   captured sample never perturbs its cast. The `mimetype` entry is re-emitted
   first and STORED (uncompressed) per the OCF spec.

   The image resize itself (ffmpeg) lives in the CLI wrapper; this module never
   shells out, so it unit-tests hermetically. */
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Resolve a `.opf`-relative href against the opf's own directory. */
function joinRel(dir, href) {
  const combined = (dir ? dir + '/' : '') + href;
  const parts = [];
  for (const seg of combined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** The OPF path, from META-INF/container.xml's first rootfile. */
export function findOpfPath(entries) {
  const container = entries['META-INF/container.xml'];
  if (!container) throw new Error('epub: missing META-INF/container.xml');
  const m = strFromU8(container).match(/<rootfile\b[^>]*\bfull-path="([^"]+)"/);
  if (!m) throw new Error('epub: no <rootfile full-path> in container.xml');
  return m[1];
}

/** Locate the cover image: the manifest item named by <meta name="cover">.
    Returns the opf text + the cover's zip path and opf-relative href. */
export function findCover(entries) {
  const opfPath = findOpfPath(entries);
  if (!entries[opfPath]) throw new Error(`epub: opf missing at ${opfPath}`);
  const opf = strFromU8(entries[opfPath]);

  const meta = opf.match(/<meta\b[^>]*\bname="cover"[^>]*\bcontent="([^"]+)"/);
  if (!meta) throw new Error('epub: no <meta name="cover"> in opf');
  const coverId = meta[1];

  const item = opf.match(new RegExp(`<item\\b[^>]*\\bid="${escapeRe(coverId)}"[^>]*?/?>`));
  if (!item) throw new Error(`epub: no manifest <item id="${coverId}">`);
  const href = item[0].match(/\bhref="([^"]+)"/);
  if (!href) throw new Error('epub: cover manifest item has no href');

  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  return {
    opfPath,
    opf,
    coverItem: item[0],
    coverHref: href[1],
    coverPath: joinRel(opfDir, href[1]),
  };
}

/** Swap the cover to `coverJpgBytes` (a JPEG). Text entries other than the opf
    and cover-referencing (x)html/svg are copied verbatim. */
export function slimEpubBuffer(inputBuf, coverJpgBytes) {
  if (!coverJpgBytes || coverJpgBytes.length === 0) {
    throw new Error('slimEpubBuffer: coverJpgBytes is required');
  }
  const entries = unzipSync(inputBuf);
  const { opfPath, opf, coverItem, coverHref, coverPath } = findCover(entries);
  if (!entries[coverPath]) throw new Error(`epub: cover file missing at ${coverPath}`);

  const newHref = coverHref.replace(/[^/]+$/, (base) => base.replace(/\.[^.]+$/, '') + '.jpg');
  const newCoverPath = coverPath.replace(/[^/]+$/, (base) => base.replace(/\.[^.]+$/, '') + '.jpg');
  const coverBase = coverHref.replace(/^.*\//, '');
  const newBase = coverBase.replace(/\.[^.]+$/, '') + '.jpg';

  // opf: retarget the cover item's href + media-type in one surgical edit.
  const newItem = coverItem
    .replace(/\bhref="[^"]+"/, `href="${newHref}"`)
    .replace(/\bmedia-type="[^"]+"/, 'media-type="image/jpeg"');
  const newOpf = opf.replace(coverItem, newItem);

  const rebuilt = {};
  for (const [name, data] of Object.entries(entries)) {
    if (name === coverPath) {
      rebuilt[newCoverPath] = coverJpgBytes; // drop the .png, add the .jpg
    } else if (name === opfPath) {
      rebuilt[name] = strToU8(newOpf);
    } else if (/\.(x?html|svg)$/i.test(name)) {
      const text = strFromU8(data);
      rebuilt[name] = text.includes(coverBase)
        ? strToU8(text.split(coverBase).join(newBase))
        : data;
    } else {
      rebuilt[name] = data;
    }
  }

  // Re-emit with mimetype first + stored (OCF requirement).
  const ordered = {};
  if (rebuilt.mimetype) ordered.mimetype = [rebuilt.mimetype, { level: 0 }];
  for (const [name, data] of Object.entries(rebuilt)) {
    if (name !== 'mimetype') ordered[name] = data;
  }
  return zipSync(ordered);
}
