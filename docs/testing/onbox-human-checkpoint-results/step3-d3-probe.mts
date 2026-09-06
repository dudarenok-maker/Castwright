// Throwaway probe script (not committed as test code) — calls the REAL,
// unmodified parseChapterStructure/buildNameIndex on a real corpus paragraph
// (Gutenberg #51828, 聊齋志異) to confirm the primary-pair-straddle recovery
// actually fires on this exact real sentence, and to get exact character
// offsets for the recovered inner turn so we can synthesize just that span.
import { parseChapterStructure } from '../../../server/src/analyzer/dialogue-structure/parser.js';
import { buildNameIndex } from '../../../server/src/analyzer/dialogue-structure/name-matcher.js';
import { zh } from '../../../server/src/analyzer/dialogue-structure/lang/zh.js';

const body =
  '彭至下馬，相向拱敬。俄，主人出，氣象剛猛，巾服都異人世。拱手向客，曰：「今日客莫遠於彭君。」因揖彭，請先行。彭謙謝，不肯遽先。主人捉臂行之。彭覺捉處如被械梏，痛欲折，不敢復爭，遂行。下此者，猶相推讓，主人或推之，或挽之，客皆呻吟傾跌，似不能堪，一依主命而行。登堂，則陳設炫麗，兩客一筵。彭暗問接坐者：「主人何人？」答云：「此張桓侯也。」彭愕然，不敢復咳。合座寂然。酒既行，桓侯曰：「歲歲叨擾親賓，聊設薄酌，盡此區區之意。值遠客辱臨，亦屬幸遇。僕竊妄有干求，如少存愛戀，即亦不強。」彭起問：「何物？」曰：「尊乘已有仙骨，非塵世所能驅策。欲市馬相易，如何？」彭曰：「敬以奉獻，不敢易也。」桓侯曰：「當報以良馬，且將賜以萬金。」彭離席伏謝。桓侯命人曳起之。俄傾，酒饌紛綸。日落，命燭。衆起辭，彭亦告別。桓侯曰：「君遠來焉歸？」彭顧同席者曰：「已求此公作居停主人矣。」桓侯乃遍以巨觴酌客。謂彭曰：「所懷香草，鮮者可以成仙，枯者可以點金；草七莖，得金一萬。」即命僮出方授彭。彭又拜謝。桓侯曰：「明日造市，請於馬羣中任意擇其良者，不必與之論價，吾自給之。又告衆曰：「遠客歸家，可少助以資斧。」衆唯唯。觴盡，謝別而出。途中始詰姓字，同座者為劉子翬。同行二三里，越嶺，即睹村舍。衆客陪彭並至劉所，始述其異。';

const roster = [
  { id: 'narrator', name: '' },
  { id: 'peng', name: '彭', aliases: ['彭好士'] },
  { id: 'huan-hou', name: '桓侯', aliases: ['張桓侯'] },
];
const index = buildNameIndex(roster, zh);
const paras = parseChapterStructure(body, index);
for (const p of paras) {
  console.log('PARAGRAPH', p.start, p.end, p.kind);
  for (const s of p.spans) {
    console.log(
      '  span',
      s.kind,
      s.start,
      s.end,
      JSON.stringify(body.slice(s.start, s.end)),
      s.speaker ?? '',
    );
  }
}
