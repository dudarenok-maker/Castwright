import type { Voice } from '../lib/types';

export const VOICE_LIBRARY: Voice[] = [
  { id: 'v_halloran',  character: 'Captain Halloran',     bookTitle: 'The Northern Star',  bookId: 'ns', attributes: ['Male','Baritone','Northern English','60s','Authoritative'], gradient: ['#3C194F','#0F0E0D'], usedIn: 3,  source: 'current' },
  { id: 'v_eliza',     character: 'Eliza Gray',           bookTitle: 'The Northern Star',  bookId: 'ns', attributes: ['Female','Alto','Working-class London','20s','Defiant'],     gradient: ['#F79A83','#A43C6C'], usedIn: 1,  source: 'current' },
  { id: 'v_marcus',    character: 'Marcus the Cook',      bookTitle: 'The Northern Star',  bookId: 'ns', attributes: ['Male','Tenor','Welsh','50s','Wry'],                          gradient: ['#7C5C8C','#3C194F'], usedIn: 0,  source: 'current' },
  { id: 'v_anders',    character: 'Narrator',             bookTitle: 'Solway Bay',         bookId: 'sb', attributes: ['Neutral','Mid-tempo','Mid-Atlantic','Warm'],                 gradient: ['#6B6663','#0F0E0D'], usedIn: 11, source: 'library', reusable: true },
  { id: 'v_keeper',    character: 'The Lighthouse Keeper', bookTitle: 'Solway Bay',        bookId: 'sb', attributes: ['Male','Bass','Scottish','70s','Weathered'],                  gradient: ['#4A6878','#1F3441'], usedIn: 1,  source: 'library' },
  { id: 'v_pemberton', character: 'Mrs. Pemberton',       bookTitle: 'Solway Bay',         bookId: 'sb', attributes: ['Female','Soprano','RP English','60s','Crisp'],               gradient: ['#C28BA8','#7A3A5C'], usedIn: 1,  source: 'library' },
  { id: 'v_boy',       character: 'The Boy on the Pier',  bookTitle: 'Solway Bay',         bookId: 'sb', attributes: ['Male','Treble','Scottish','12','Curious'],                   gradient: ['#A8D5BA','#4A7B6B'], usedIn: 1,  source: 'library' },
  { id: 'v_navigator', character: 'First Mate Greene',    bookTitle: "Carrick's Compass",  bookId: 'cc', attributes: ['Female','Mezzo','Irish','40s','Pragmatic'],                  gradient: ['#D4A04E','#7B5A26'], usedIn: 2,  source: 'library' },
];
