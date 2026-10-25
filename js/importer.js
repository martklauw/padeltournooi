// Deelnemers inlezen uit CSV of Excel. Het bestand wordt alleen in het geheugen gelezen en
// nergens opgeslagen; van elke deelnemer bewaren we alleen de voornaam en de eerste letter
// van de achternaam (bijv. "Monique van Doorn" -> "Monique D.").
const Importer = (() => {
  const SHEETJS_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
  const EXCEL_EXT = /\.(xlsx|xlsm|xlsb|xls|ods|numbers)$/i;

  // Kolomkoppen (kleine letters, alleen letters) die we herkennen.
  const COLS = {
    full: ['naam', 'name', 'volledigenaam', 'fullname', 'deelnemer', 'deelnemers', 'speler', 'spelers', 'participant', 'medewerker', 'persoon', 'displayname', 'weergavenaam'],
    first: ['voornaam', 'roepnaam', 'firstname', 'givenname', 'first', 'voornamen'],
    last: ['achternaam', 'lastname', 'surname', 'familienaam', 'familyname', 'last', 'geslachtsnaam'],
    level: ['ervaringsniveau', 'niveau', 'level', 'ervaring', 'speelniveau', 'experience', 'skill', 'skilllevel', 'klasse', 'categorie', 'category', 'padelniveau', 'groep'],
  };

  // Tussenvoegsels tellen niet mee voor de eerste letter van de achternaam.
  const PARTICLES = new Set(['van', 'de', 'der', 'den', 'het', 'ter', 'ten', 'te', 'in', "'t", 't', 'op', 'aan', 'bij', 'uit',
    'vd', 'v/d', 'v.d.', 'von', 'zu', 'du', 'da', 'di', 'del', 'della', 'la', 'le', 'el', 'al', 'dos', 'das', 'do', 'mc', 'o']);

  const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');

  // 3 = beginner, 7 = gevorderd, 5 = weet ik niet (zelfde waarden als in de app).
  function parseLevel(v) {
    const s = String(v ?? '').trim().toLowerCase();
    if (!s) return 5;
    const n = Number(s.replace(',', '.'));
    if (Number.isFinite(n) && n > 0) return n <= 4 ? 3 : n >= 6 ? 7 : 5;
    if (/(recrea|beginn|starter|novice|laag|basis|instap|weinig|geen erv|nieuw)/.test(s)) return 3;
    if (/(ervaren|gevorderd|advanced|expert|competitie|hoog|goed|sterk|veel)/.test(s)) return 7;
    if (/^(b|beg)$/.test(s)) return 3;
    if (/^(g|gev|e|erv)$/.test(s)) return 7;
    return 5; // onbekend, geen voorkeur, weet ik niet, ...
  }

  // ---------- bestand lezen ----------

  async function parseFile(file) {
    const rows = EXCEL_EXT.test(file.name) ? await readExcel(file) : readCsv(decode(await file.arrayBuffer()));
    return extract(rows);
  }

  // UTF-8 als het klopt, anders Windows-1252 (Excel "CSV (gescheiden door lijstscheidingsteken)").
  function decode(buf) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch (e) { text = new TextDecoder('windows-1252').decode(buf); }
    return text.replace(/^﻿/, '');
  }

  function readCsv(text) {
    const firstLines = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 5).join('\n');
    const delim = [';', ',', '\t', '|']
      .map(d => ({ d, n: firstLines.split(d).length }))
      .sort((a, b) => b.n - a.n)[0].d;
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"' && cell === '') {
        quoted = true;
      } else if (c === delim) {
        row.push(cell); cell = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else {
        cell += c;
      }
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function loadSheetJS() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SHEETJS_URL;
      s.onload = () => resolve(window.XLSX);
      s.onerror = () => reject(new Error('De Excel-lezer kon niet worden geladen. Is er internet? Je kunt het bestand ook als CSV opslaan.'));
      document.head.appendChild(s);
    });
  }

  async function readExcel(file) {
    const XLSX = await loadSheetJS();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const sheets = wb.SheetNames.map(n => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '', raw: false }));
    // Het tabblad met een herkenbare naamkolom, anders het eerste met inhoud.
    return sheets.find(rows => findHeader(rows)) || sheets.find(rows => rows.some(r => r.some(c => String(c).trim()))) || [];
  }

  // ---------- kolommen herkennen ----------

  function findHeader(rows) {
    for (let r = 0; r < Math.min(rows.length, 15); r++) {
      const cells = rows[r].map(norm);
      const idx = key => cells.findIndex(c => COLS[key].includes(c));
      const cols = { full: idx('full'), first: idx('first'), last: idx('last'), level: idx('level') };
      if (cols.full >= 0 || cols.first >= 0) return { row: r, cols };
    }
    return null;
  }

  function extract(rows) {
    rows = rows.map(r => r.map(c => String(c ?? '').trim()));
    let header = findHeader(rows);
    if (!header) {
      // Geen kopregel: eerste kolom is de naam, tweede (als die er is) het niveau.
      header = { row: -1, cols: { full: 0, first: -1, last: -1, level: rows.some(r => r[1]) ? 1 : -1 } };
    }
    const { cols } = header;
    const people = [];
    let skipped = 0;
    rows.slice(header.row + 1).forEach(r => {
      let first, last;
      if (cols.first >= 0) {
        first = r[cols.first];
        last = cols.last >= 0 ? r[cols.last] : '';
        if (!first && cols.full >= 0) ({ first, last } = splitFull(r[cols.full]));
      } else {
        ({ first, last } = splitFull(r[cols.full]));
      }
      // Lege regels en tel-/somregels ("Totaal: 4") overslaan.
      if (!first || !/\p{L}/u.test(first) || /\d/.test(first) || /^(totaal|total|aantal|som|subtotaal)\b/i.test(first)) {
        if (r.some(c => c)) skipped++;
        return;
      }
      people.push({ first: cap(first), last, level: cols.level >= 0 ? parseLevel(r[cols.level]) : 5 });
    });
    return { players: shorten(people), skipped };
  }

  // "Monique van Doorn" of "Doorn, Monique van" -> voornaam + rest.
  function splitFull(full) {
    full = String(full ?? '').replace(/\s+/g, ' ').trim();
    if (!full) return { first: '', last: '' };
    if (full.includes(',')) {
      const [last, first] = full.split(',').map(s => s.trim());
      return { first: (first || '').split(' ')[0], last: [last, ...(first || '').split(' ').slice(1)].reverse().join(' ') };
    }
    const parts = full.split(' ');
    return { first: parts[0], last: parts.slice(1).join(' ') };
  }

  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  // Achternaam zonder tussenvoegsels, bijv. "van der Leeden" -> "Leeden", "Boos - van Beresteijn" -> "Boos".
  function coreSurname(last) {
    return String(last ?? '').split(/[\s-]+/).find(w => w && /\p{L}/u.test(w) && !PARTICLES.has(w.toLowerCase())) || '';
  }

  // Voornaam + eerste letter achternaam; bij dubbele uitkomsten meer letters ("Bas He.").
  function shorten(people) {
    const make = (p, n) => {
      const core = coreSurname(p.last);
      return core ? `${p.first} ${cap(core.slice(0, n))}.` : p.first;
    };
    people.forEach(p => { p.n = 1; p.name = make(p, 1); });
    for (let round = 0; round < 12; round++) {
      const groups = new Map();
      people.forEach(p => groups.set(p.name.toLowerCase(), [...(groups.get(p.name.toLowerCase()) || []), p]));
      let changed = false;
      groups.forEach(g => {
        if (g.length < 2) return;
        g.forEach(p => {
          const core = coreSurname(p.last);
          if (p.n < core.length) { p.n++; p.name = make(p, p.n); changed = true; }
        });
      });
      if (!changed) break;
    }
    // Nog steeds gelijk (zelfde naam twee keer): nummeren.
    const seen = new Map();
    return people.map(p => {
      const k = p.name.toLowerCase();
      const c = (seen.get(k) || 0) + 1;
      seen.set(k, c);
      return { name: c > 1 ? `${p.name} (${c})` : p.name, level: p.level };
    });
  }

  return { parseFile, parseLevel };
})();
