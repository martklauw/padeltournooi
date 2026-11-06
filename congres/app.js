// Congresprogramma: blokkenschema, sessielijst, persoonlijk schema en beheer.
(() => {
  /* ===================== Huisstijlkleuren voor sessietypes ===================== */
  const PALET = {
    navy:     { naam: 'Donkerblauw', c: '#2f335b', bg: '#e2e3ee' },
    roze:     { naam: 'BOOR roze',   c: '#c70a64', bg: '#f7dde9' },
    blauw:    { naam: 'BOOR blauw',  c: '#0090ad', bg: '#d6eef3' },
    oranje:   { naam: 'Tint oranje', c: '#fac075', bg: '#feecd3' },
    groen:    { naam: 'Tint groen',  c: '#b0ddae', bg: '#e5f4e4' },
    geel:     { naam: 'Tint geel',   c: '#f0e67b', bg: '#faf6d2' },
    tintroze: { naam: 'Tint roze',   c: '#e9bfd1', bg: '#f6e8ee' },
  };

  /* ===================== Hulpfuncties ===================== */
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toMin = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
  const fmt = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const clone = o => JSON.parse(JSON.stringify(o));
  const newId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const overlap = (a, b) => a.start < b.eind && b.start < a.eind;
  const validTime = s => /^\d{1,2}:\d{2}$/.test(s);

  const DATA_KEY = 'rtc-congres-data';     // alleen lokaal (zonder Firebase)
  const SCHEMA_KEY = 'rtc2027-schema';     // persoonlijk schema van de bezoeker

  /* ===================== Toestand ===================== */
  let data = normalize(!Cloud.enabled && JSON.parse(localStorage.getItem(DATA_KEY) || 'null') || clone(window.STANDAARD_PROGRAMMA));
  let mijn = new Set(JSON.parse(localStorage.getItem(SCHEMA_KEY) || '[]'));
  const filter = { q: '', types: new Set(), at: '', dur: '', fits: false, win: null };
  let view = 'grid';
  let openId = null;
  let SESSIES = [], BY_ID = {}, DAG_START = 660, DAG_EIND = 930, DAG_LEN = 270;

  function normalize(d) {
    d = d || {};
    d.info = Object.assign({ naam: 'Congres', ondertitel: '', datum: '', locatie: '', intro: '', overOns: window.STANDAARD_PROGRAMMA.info?.overOns || '' }, d.info || {});
    d.typen = Array.isArray(d.typen) ? d.typen : [];
    d.zalen = Array.isArray(d.zalen) ? d.zalen : [];
    if (!Array.isArray(d.sprekers)) d.sprekers = clone(window.STANDAARD_PROGRAMMA.sprekers || []);
    d.sprekers = d.sprekers.filter(x => x && x.naam).map(x => ({ zoek: x.naam, organisatie: '', status: 'concept', bio: '', bronnen: [], ...x }));
    d.sessies = (Array.isArray(d.sessies) ? d.sessies : []).filter(s => s && s.id && validTime(s.start) && validTime(s.eind));
    return d;
  }

  function prepare() {
    const zaalIdx = Object.fromEntries(data.zalen.map((z, i) => [z.naam, i]));
    const cap = Object.fromEntries(data.zalen.map(z => [z.naam, z.capaciteit]));
    SESSIES = data.sessies.map(s => {
      const start = toMin(s.start), eind = toMin(s.eind);
      return {
        ...s, start, eind, duur: eind - start, cap: cap[s.zaal],
        key: norm(s.titel + '|' + s.spreker),
        zoek: norm([s.titel, s.type, s.spreker, s.zaal, s.samenvatting, s.beschrijving, s.doelgroep].join(' ')),
      };
    }).sort((a, b) => a.start - b.start || (zaalIdx[a.zaal] ?? 99) - (zaalIdx[b.zaal] ?? 99));
    BY_ID = Object.fromEntries(SESSIES.map(s => [s.id, s]));
    if (SESSIES.length) {
      DAG_START = Math.floor(Math.min(...SESSIES.map(s => s.start)) / 30) * 30;
      DAG_EIND = Math.ceil(Math.max(...SESSIES.map(s => s.eind)) / 30) * 30;
    }
    DAG_LEN = Math.max(30, DAG_EIND - DAG_START);
  }

  const sprekersVan = s => data.sprekers.filter(x => x.zoek && norm(s.spreker).includes(norm(x.zoek)));
  const sprekerAnker = x => 'spreker-' + norm(x.naam).replace(/[^a-z0-9]+/g, '-');
  const typeInfo = naam => data.typen.find(t => t.naam === naam) || { naam, kleur: 'navy', uitleg: '' };
  const kleurVars = type => { const p = PALET[typeInfo(type).kleur] || PALET.navy; return `--c:${p.c};--bg-c:${p.bg}`; };
  const editable = () => !Cloud.enabled || Cloud.canEdit();

  function bewaarSchema() { localStorage.setItem(SCHEMA_KEY, JSON.stringify([...mijn])); }
  function mijnSessies() { return [...mijn].map(id => BY_ID[id]).filter(Boolean).sort((a, b) => a.start - b.start); }
  function botsingen(s) { return mijnSessies().filter(m => m.id !== s.id && overlap(m, s)); }

  function past(s) {
    if (filter.q && !filter.q.split(/\s+/).every(w => s.zoek.includes(w))) return false;
    if (filter.types.size && !filter.types.has(s.type)) return false;
    if (filter.at) { const t = +filter.at; if (!(s.start <= t && t < s.eind)) return false; }
    if (filter.dur) { const d = +filter.dur; if (d === 61 ? s.duur <= 60 : s.duur > d) return false; }
    if (filter.win && !(s.start >= filter.win[0] && s.eind <= filter.win[1])) return false;
    if (filter.fits && !mijn.has(s.id) && botsingen(s).length) return false;
    return true;
  }

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function toggle(id, { vervang = false } = {}) {
    const s = BY_ID[id];
    if (!s) return;
    if (mijn.has(id)) { mijn.delete(id); toast(`Verwijderd: ${s.titel}`); }
    else {
      const b = botsingen(s);
      if (vervang) b.forEach(x => mijn.delete(x.id));
      mijnSessies().filter(m => m.key === s.key).forEach(m => mijn.delete(m.id)); // zelfde sessie op ander tijdstip
      mijn.add(id);
      toast(b.length && !vervang ? `Toegevoegd – let op: botst met ${b.length} andere sessie(s)` : `Toegevoegd: ${s.titel}`);
    }
    bewaarSchema(); render();
  }

  /* ===================== Wijzigen door beheerders ===================== */
  function wijzig(fn, melding) {
    if (!editable()) return;
    fn(data);
    data = normalize(data);
    if (Cloud.enabled) Cloud.save(data);
    else localStorage.setItem(DATA_KEY, JSON.stringify(data));
    prepare();
    render();
    if (melding) toast(melding);
  }

  /* ===================== Weergave: algemeen ===================== */
  function renderHero() {
    const i = data.info;
    $('#heroTitle').textContent = i.naam;
    $('#heroSub').textContent = i.ondertitel;
    $('#heroIntro').textContent = i.intro;
    $('#brandName').textContent = i.naam;
    document.title = i.naam;
    const datum = i.datum ? new Date(i.datum + 'T12:00').toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '';
    $('#stats').innerHTML = `
      ${datum ? `<div><b>${esc(datum)}</b>${esc(i.locatie)}</div>` : ''}
      <div><b>${SESSIES.length}</b>sessies</div>
      <div><b>${new Set(SESSIES.map(s => s.key)).size}</b>onderwerpen</div>
      <div><b>${data.zalen.length}</b>zalen</div>
      ${SESSIES.length ? `<div><b>${fmt(DAG_START)} – ${fmt(DAG_EIND)}</b>programma</div>` : ''}`;
    $('#footer').textContent = `${i.naam} · Een initiatief van stichting BOOR · Wijzigingen in het programma voorbehouden.`;
  }

  function renderChips() {
    const used = data.typen.filter(t => SESSIES.some(s => s.type === t.naam));
    $('#typechips').innerHTML = used.map(t => `
      <button class="chip" data-type="${esc(t.naam)}" aria-pressed="${filter.types.has(t.naam)}" style="${kleurVars(t.naam)}">
        <span class="dot"></span>${esc(t.naam)} <small>(${SESSIES.filter(s => s.type === t.naam).length})</small></button>`).join('');
  }

  function renderTimes() {
    const sel = $('#at'), cur = sel.value;
    let html = '<option value="">Elk tijdstip</option>';
    for (let m = DAG_START; m < DAG_EIND; m += 15) html += `<option value="${m}">Bezig om ${fmt(m)}</option>`;
    sel.innerHTML = html; sel.value = cur;
  }

  function blokHTML(s) {
    const isMine = mijn.has(s.id);
    const clash = !isMine && botsingen(s).length > 0;
    const cls = ['blk', isMine && 'mine', clash && 'clash', !past(s) && 'dim'].filter(Boolean).join(' ');
    const left = (s.start - DAG_START) / DAG_LEN * 100, width = s.duur / DAG_LEN * 100;
    return `<button class="${cls}" data-open="${s.id}" style="${kleurVars(s.type)};left:calc(${left}% + 2px);width:calc(${width}% - 4px)"
      title="${esc(`${fmt(s.start)}–${fmt(s.eind)} · ${s.titel} · ${s.spreker}`)}">
      <div class="t">${esc(s.titel)}</div><div class="s">${fmt(s.start)}–${fmt(s.eind)} · ${esc(s.spreker)}</div></button>`;
  }

  function renderGrid() {
    const n = DAG_LEN / 30;
    let ticks = '';
    for (let m = DAG_START; m < DAG_EIND; m += 30) ticks += `<span class="tick" style="left:${(m - DAG_START) / DAG_LEN * 100}%">${fmt(m)}</span>`;
    let html = `<div class="g-row g-head"><div class="g-room"><b>Zaal</b></div><div class="g-track">${ticks}</div></div>`;
    const nu = filter.at ? `<div class="nowline" style="left:${(+filter.at - DAG_START) / DAG_LEN * 100}%"></div>` : '';
    for (const z of data.zalen) {
      const blokken = SESSIES.filter(s => s.zaal === z.naam).map(blokHTML).join('');
      if (!blokken) continue;
      html += `<div class="g-row"><div class="g-room"><b>${esc(z.naam)}</b><span>${z.capaciteit ? z.capaciteit + ' plaatsen' : ''}</span></div><div class="g-track">${blokken}${nu}</div></div>`;
    }
    const grid = $('#grid');
    grid.style.setProperty('--n', n);
    grid.innerHTML = SESSIES.length ? html : '<div class="empty">Er staan nog geen sessies in het programma.</div>';
  }

  function knop(s) {
    return mijn.has(s.id)
      ? `<button class="btn added" data-toggle="${s.id}">✓ In mijn schema</button>`
      : `<button class="btn primary" data-toggle="${s.id}">+ Toevoegen</button>`;
  }

  function renderList() {
    const lijst = SESSIES.filter(past);
    $('#listcount').innerHTML = `${lijst.length} van ${SESSIES.length} sessies`
      + (filter.win ? ` · passend tussen ${fmt(filter.win[0])} en ${fmt(filter.win[1])} <button class="linkbtn" data-clearwin>✕ tijdvak wissen</button>` : '');
    if (!lijst.length) { $('#list').innerHTML = '<div class="empty">Geen sessies gevonden. Probeer andere filters.</div>'; return; }
    $('#list').innerHTML = lijst.map(s => {
      const b = mijn.has(s.id) ? [] : botsingen(s);
      const herhaling = SESSIES.filter(x => x.key === s.key && x.id !== s.id);
      return `<article class="scard" style="${kleurVars(s.type)}">
        <div><span class="badge">${esc(s.type)}</span></div>
        <h3><button data-open="${s.id}">${esc(s.titel)}</button></h3>
        <div class="meta"><span>🕒 ${fmt(s.start)}–${fmt(s.eind)} (${s.duur} min)</span><span>📍 ${esc(s.zaal)}${s.cap ? ` · ${s.cap} pl.` : ''}</span></div>
        <div class="meta"><span>👤 ${esc(s.spreker)}</span></div>
        ${s.samenvatting ? `<p class="summary">${esc(s.samenvatting)}</p>` : ''}
        ${s.fotoId || s.video ? `<div class="meta">${s.fotoId ? '<span>📷 Met foto</span>' : ''}${s.video ? '<span>🎬 Met video</span>' : ''}</div>` : ''}
        ${herhaling.length ? `<div class="meta"><span>🔁 Ook om ${herhaling.map(h => fmt(h.start)).join(', ')}</span></div>` : ''}
        ${b.length ? `<div class="warn">⚠️ Botst met: ${b.map(x => esc(x.titel)).join(', ')}</div>` : ''}
        <div class="actions">${knop(s)}<button class="linkbtn" data-open="${s.id}">Meer info</button></div>
      </article>`;
    }).join('');
  }

  function renderMy() {
    const m = mijnSessies();
    $('#mycount').textContent = m.length;
    $('.print-title').textContent = `Mijn schema – ${data.info.naam}`;
    $('#ics').hidden = !data.info.datum;
    if (!m.length) {
      $('#mytimeline').innerHTML = `<div class="empty"><p><b>Je schema is nog leeg.</b></p><p>Kies sessies in het blokkenschema of in de lijst met alle sessies.</p>
        <button class="btn primary" data-view="grid">Naar het blokkenschema</button></div>`;
      $('#mysummary').textContent = 'Nog geen sessies gekozen.';
      return;
    }
    let html = '', cursor = DAG_START;
    const gapHTML = (a, b) => `<div class="tl-item"><div class="when">${fmt(a)}</div><div class="gap"><span>Vrij: ${fmt(a)} – ${fmt(b)} (${b - a} min)</span>
        ${b - a >= 30 ? `<button class="linkbtn" data-gap="${a}-${b}">Wat past hier?</button>` : ''}</div></div>`;
    for (const s of m) {
      if (s.start > cursor) html += gapHTML(cursor, s.start);
      const b = botsingen(s);
      html += `<div class="tl-item"><div class="when">${fmt(s.start)}</div>
        <div class="tl-card ${b.length ? 'clash' : ''}" style="${kleurVars(s.type)}">
          <div><span class="badge" style="background:#fff">${esc(s.type)}</span>
            <div><button class="title" data-open="${s.id}">${esc(s.titel)}</button></div>
            <div class="meta"><span>${fmt(s.start)}–${fmt(s.eind)}</span><span>📍 ${esc(s.zaal)}</span><span>👤 ${esc(s.spreker)}</span></div>
            ${b.length ? `<div class="warn">⚠️ Overlapt met ${b.map(x => esc(x.titel)).join(', ')}</div>` : ''}
          </div>
          <button class="icon-btn" data-toggle="${s.id}" aria-label="Verwijder uit mijn schema">✕</button>
        </div></div>`;
      cursor = Math.max(cursor, s.eind);
    }
    if (cursor < DAG_EIND) html += gapHTML(cursor, DAG_EIND);
    $('#mytimeline').innerHTML = html;
    const totaal = m.reduce((a, s) => a + s.duur, 0);
    const clashes = m.filter(s => botsingen(s).length).length;
    $('#mysummary').innerHTML = `${m.length} sessie(s) · ${Math.floor(totaal / 60)} u ${totaal % 60} min programma<br>
      ${clashes ? `<span class="warn">⚠️ ${clashes} sessies overlappen – kies er één.</span>` : '<span class="saved">✓ Geen overlappingen</span>'}`;
  }

  function renderCloud() {
    document.body.classList.toggle('editor', editable());
    const bar = $('#cloudBar');
    if (!Cloud.enabled) { bar.innerHTML = '<span class="cloud-user" title="Wijzigingen worden alleen in deze browser bewaard">Lokale versie</span>'; return; }
    const st = Cloud.status(), u = Cloud.user();
    const dot = st === 'error' ? '⚠️ Offline' : st !== 'live' ? 'Verbinden…' : Cloud.canEdit() ? '<span class="dot-live"></span>Live' : '';
    bar.innerHTML = (dot ? `<span class="cloud-state">${dot}</span>` : '')
      + (u ? `<span class="cloud-user" title="${esc(u.email)}">${Cloud.canEdit() ? 'Beheerder' : 'Bezoeker'}</span><button class="btn ghost small" data-action="signout">Uitloggen</button>`
        : '<button class="btn ghost small" data-action="signin">Inloggen beheer</button>');
  }

  function render() {
    if (view === 'beheer' && !editable()) view = 'grid';
    renderCloud(); renderHero(); renderChips(); renderGrid(); renderList(); renderMy();
    renderBeheer();
    document.querySelectorAll('.tabs [data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    renderSprekers();
    $('#overTekst').innerHTML = opmaak(data.info.overOns) || '<p class="hint">Nog geen tekst.</p>';
    ['grid', 'list', 'sprekers', 'over', 'my', 'beheer'].forEach(v => { $('#view-' + v).hidden = v !== view; });
    $('#filters').hidden = !(view === 'grid' || view === 'list');
    if ($('#modal').open && openId) openDetail(openId);
  }

  /* ===================== Sprekers ===================== */
  let sprekerZoek = '';
  function renderSprekers() {
    const el = $('#view-sprekers');
    const q = norm(sprekerZoek);
    const lijst = [...data.sprekers]
      .map(x => ({ x, sessies: SESSIES.filter(s => norm(s.spreker).includes(norm(x.zoek))) }))
      .filter(({ x, sessies }) => sessies.length && (!q || norm([x.naam, x.organisatie, x.bio, ...sessies.map(s => s.titel)].join(' ')).includes(q)))
      .sort((a, b) => a.x.naam.localeCompare(b.x.naam, 'nl'));
    const kaarten = lijst.map(({ x, sessies }) => `
      <article class="spreker" id="${sprekerAnker(x)}">
        <div class="spreker-kop">
          <div class="avatar" aria-hidden="true">${esc(x.naam.split(/\s+/).filter(w => /^[A-ZÀ-Ý]/.test(w)).slice(0, 2).map(w => w[0]).join('') || x.naam[0])}</div>
          <div><h3>${esc(x.naam)}</h3>${x.organisatie ? `<div class="meta">${esc(x.organisatie)}</div>` : ''}</div>
        </div>
        ${x.bio ? `<div class="rich">${opmaak(x.bio)}</div>` : '<p class="hint">Meer informatie volgt.</p>'}
        <div class="spreker-sessies">${sessies.map(s => `<button class="sessie-chip" data-open="${s.id}" style="${kleurVars(s.type)}">
          <b>${fmt(s.start)}</b> ${esc(s.titel)} <span>· ${esc(s.zaal)}</span></button>`).join('')}</div>
      </article>`).join('');
    const lijstHTML = kaarten || '<div class="empty">Geen sprekers gevonden.</div>';
    if ($('#sprekerLijst') && el.contains(document.activeElement)) { $('#sprekerLijst').innerHTML = lijstHTML; return; }
    el.innerHTML = `
      <div class="card filterbar"><div class="filters">
        <input type="search" id="sprekerZoek" placeholder="Zoek een spreker, organisatie of onderwerp…" value="${esc(sprekerZoek)}">
        <span class="hint" style="margin:0">${lijst.length} sprekers en organisaties</span>
      </div></div>
      <div class="sprekers" id="sprekerLijst">${lijstHTML}</div>`;
  }

  /* ===================== Detailvenster ===================== */
  function openDetail(id) {
    const s = BY_ID[id];
    if (!s) { $('#modal').close(); return; }
    openId = id;
    const info = typeInfo(s.type);
    const anderen = SESSIES.filter(x => x.key === s.key && x.id !== s.id);
    const zelfdeSpreker = SESSIES.filter(x => x.key !== s.key && x.spreker === s.spreker);
    const b = mijn.has(id) ? [] : botsingen(s);
    const parallel = SESSIES.filter(x => x.id !== s.id && overlap(x, s)).length;
    const altRij = x => `<div class="alt"><span><b>${fmt(x.start)}–${fmt(x.eind)}</b> · ${esc(x.zaal)}${x.key !== s.key ? ` · <button class="linkbtn" style="padding:0" data-open="${x.id}">${esc(x.titel)}</button>` : ''}</span>${knop(x)}</div>`;
    $('#modal-content').innerHTML = `
      <div class="m-head" style="${kleurVars(s.type)}">
        <span class="badge">${esc(s.type)}</span>
        <h2>${esc(s.titel)}</h2>
        <button class="m-close" data-close aria-label="Sluiten">✕</button>
      </div>
      ${s.fotoId ? '<div class="m-photo" id="mFoto"><div class="photo-ph"></div></div>' : ''}
      <div class="m-body">
        <dl class="facts">
          <dt>Tijd</dt><dd>${fmt(s.start)} – ${fmt(s.eind)} uur (${s.duur} minuten)</dd>
          <dt>Zaal</dt><dd>${esc(s.zaal)}${s.cap ? ` · ${s.cap} plaatsen` : ''}</dd>
          <dt>Door</dt><dd>${esc(s.spreker)}${sprekersVan(s).length ? ` · <button class="linkbtn" style="padding:0" data-spreker="${esc(sprekersVan(s)[0].naam)}">over de spreker</button>` : ''}</dd>
        </dl>
        ${s.samenvatting ? `<p class="lead">${esc(s.samenvatting)}</p>` : ''}
        ${s.beschrijving ? `<div class="rich">${opmaak(s.beschrijving)}</div>` : ''}
        ${s.doelgroep ? `<h4>Voor wie</h4><div class="rich">${opmaak(s.doelgroep)}</div>` : ''}
        ${videoEmbed(s.video) ? `<h4>Video</h4><div class="video"><iframe src="${esc(videoEmbed(s.video))}" title="Video bij ${esc(s.titel)}" loading="lazy" allow="fullscreen; picture-in-picture; encrypted-media" allowfullscreen></iframe></div>` : ''}
        ${s.sprekerInfo ? `<h4>Over ${esc(s.spreker)}</h4><div class="rich">${opmaak(s.sprekerInfo)}</div>`
          : sprekersVan(s).filter(x => x.bio).map(x => `<h4>Over ${esc(x.naam)}</h4><div class="rich">${opmaak(x.bio)}</div>`).join('')}
        ${info.uitleg ? `<p class="hint"><b>Wat is een ${esc(s.type.toLowerCase())}?</b> ${esc(info.uitleg)}</p>` : ''}
        ${b.length ? `<div class="clashbox">⚠️ Deze sessie overlapt met je keuze: <b>${b.map(x => esc(x.titel) + ` (${fmt(x.start)}–${fmt(x.eind)})`).join(', ')}</b>.
           <div style="margin-top:8px"><button class="btn pink" data-replace="${s.id}">Vervang door deze sessie</button></div></div>` : ''}
        <div class="inline" style="margin-top:12px">${knop(s)}
          <button class="btn ghost" data-attime="${s.start}">Alles om ${fmt(s.start)} (${parallel} parallel)</button>
          ${editable() ? `<button class="btn ghost" data-edit="${s.id}">✏️ Bewerken</button>` : ''}</div>
        ${anderen.length ? `<h4>Deze sessie wordt ook gegeven om</h4>${anderen.map(altRij).join('')}` : '<h4>Eenmalig</h4><p class="hint">Deze sessie wordt maar één keer gegeven.</p>'}
        ${zelfdeSpreker.length ? `<h4>Meer van ${esc(s.spreker)}</h4>${zelfdeSpreker.map(altRij).join('')}` : ''}
      </div>`;
    $('#modal').classList.remove('wide');
    if (!$('#modal').open) $('#modal').showModal();
    if (s.fotoId) loadFoto(s.fotoId).then(src => {
      const el = $('#mFoto');
      if (!el || openId !== id) return;
      if (src) el.innerHTML = `<img src="${src}" alt="${esc(s.fotoAlt || s.titel)}">`;
      else el.remove();
    });
  }

  /* ===================== Uitleg: opmaak, foto's en video ===================== */
  // Eenvoudige opmaak: lege regel = nieuwe alinea, regels met "- " = opsomming, **vet**, links worden klikbaar.
  function opmaak(t) {
    const inline = x => esc(x)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    const isItem = r => /^\s*[-•*]\s+/.test(r);
    return String(t || '').trim().split(/\n\s*\n/).map(blok => {
      const kop = blok.match(/^##\s+(.+)(\n[\s\S]*)?$/);
      if (kop) return '<h3>' + inline(kop[1]) + '</h3>' + (kop[2] ? opmaak(kop[2]) : '');
      // Opeenvolgende "- "-regels worden een lijst; overige regels een alinea.
      let html = '', tekst = [], items = [];
      const flush = () => {
        if (tekst.length) html += '<p>' + tekst.map(inline).join('<br>') + '</p>';
        if (items.length) html += '<ul>' + items.map(r => '<li>' + inline(r.replace(/^\s*[-•*]\s+/, '')) + '</li>').join('') + '</ul>';
        tekst = []; items = [];
      };
      for (const r of blok.split('\n')) {
        if (isItem(r)) { if (tekst.length) { html += '<p>' + tekst.map(inline).join('<br>') + '</p>'; tekst = []; } items.push(r); }
        else { if (items.length) flush(); tekst.push(r); }
      }
      flush();
      return html;
    }).join('');
  }

  // YouTube- of Vimeo-link omzetten naar een insluitlink (YouTube zonder tracking-cookies).
  function videoEmbed(url) {
    if (!url) return null;
    try {
      const u = new URL(url);
      const h = u.hostname.replace(/^(www|m)\./, '');
      let id = null;
      if (h === 'youtu.be') id = u.pathname.slice(1);
      else if (h.endsWith('youtube.com') || h.endsWith('youtube-nocookie.com')) id = u.searchParams.get('v') || (u.pathname.match(/^\/(shorts|embed|live)\/([\w-]+)/) || [])[2];
      if (id && /^[\w-]{6,}$/.test(id)) return `https://www.youtube-nocookie.com/embed/${id}`;
      if (h === 'vimeo.com' || h === 'player.vimeo.com') { const m = u.pathname.match(/(\d{5,})/); if (m) return `https://player.vimeo.com/video/${m[1]}`; }
    } catch (e) { /* geen geldige link */ }
    return null;
  }

  // Foto's staan los van het programma in /congresMedia/{id} en worden pas geladen als iemand de sessie opent.
  const fotoCache = {};
  const MEDIA_KEY = id => 'rtc-congres-media-' + id;
  function loadFoto(id) {
    if (!id) return Promise.resolve(null);
    if (!fotoCache[id]) fotoCache[id] = (Cloud.enabled ? Cloud.getMedia(id) : Promise.resolve(localStorage.getItem(MEDIA_KEY(id)))).catch(() => null);
    return fotoCache[id];
  }
  function saveFoto(id, src) {
    fotoCache[id] = Promise.resolve(src);
    if (Cloud.enabled) return Cloud.setMedia(id, src);
    try { localStorage.setItem(MEDIA_KEY(id), src); return Promise.resolve(); } catch (e) { return Promise.reject(new Error('De browseropslag is vol')); }
  }
  function removeFoto(id) {
    delete fotoCache[id];
    if (Cloud.enabled) return Cloud.setMedia(id, null);
    localStorage.removeItem(MEDIA_KEY(id)); return Promise.resolve();
  }
  // Foto's die door geen enkele sessie meer worden gebruikt opruimen.
  function opruimenFotos(ids) {
    [...new Set(ids)].filter(id => id && !data.sessies.some(s => s.fotoId === id)).forEach(id => removeFoto(id).catch(() => {}));
  }

  // Afbeelding verkleinen en comprimeren tot een JPEG van hooguit ~250 kB.
  function comprimeer(file) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(img.src);
        for (const max of [1400, 1200, 1000, 800, 640]) {
          const sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
          const c = document.createElement('canvas');
          c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
          const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
          for (const q of [0.82, 0.72, 0.62, 0.52]) {
            const out = c.toDataURL('image/jpeg', q);
            if (out.length < 340000) return res(out);
          }
        }
        rej(new Error('De foto is te groot om te verkleinen'));
      };
      img.onerror = () => rej(new Error('Dit bestand is geen afbeelding die de browser kan lezen'));
      img.src = URL.createObjectURL(file);
    });
  }

  /* ===================== Beheer ===================== */
  let beheerZoek = '';

  function renderBeheer() {
    const el = $('#view-beheer');
    if (!editable()) { el.innerHTML = ''; return; }
    // Niet opnieuw opbouwen terwijl iemand in een veld typt.
    if (el.contains(document.activeElement) && document.activeElement.matches('input,textarea,select') && el.innerHTML) return;
    const i = data.info;
    const zq = norm(beheerZoek);
    const lijst = SESSIES.filter(s => !zq || s.zoek.includes(zq));
    const typeOpts = sel => data.typen.map(t => `<option ${t.naam === sel ? 'selected' : ''}>${esc(t.naam)}</option>`).join('');
    el.innerHTML = `
      ${Cloud.enabled && Cloud.remoteEmpty() ? `<div class="alert">Het programma staat nog niet online; bezoekers zien nu het standaardprogramma. <button class="btn small primary" data-publish>Nu online zetten</button></div>` : ''}
      ${!Cloud.enabled ? '<div class="alert">Lokale versie: wijzigingen worden alleen in deze browser bewaard. Open de online versie om voor iedereen te publiceren.</div>' : ''}
      <div class="beheer">
        <section class="card">
          <h2>Congres</h2>
          <p class="hint">Wijzigingen worden direct opgeslagen en zijn meteen zichtbaar voor bezoekers.</p>
          <label class="field">Naam<input type="text" data-info="naam" value="${esc(i.naam)}"></label>
          <label class="field">Ondertitel / thema<input type="text" data-info="ondertitel" value="${esc(i.ondertitel)}"></label>
          <div class="two">
            <label class="field">Datum<input type="date" data-info="datum" value="${esc(i.datum)}"></label>
            <label class="field">Locatie<input type="text" data-info="locatie" value="${esc(i.locatie)}"></label>
          </div>
          <label class="field">Introductietekst<textarea data-info="intro">${esc(i.intro)}</textarea></label>
          <label class="field">Pagina "Over ons"<textarea data-info="overOns" rows="10">${esc(i.overOns)}</textarea>
            <small class="hint">Opmaak: "## " aan het begin van een regel = tussenkopje · lege regel = nieuwe alinea · "- " = opsomming · **vet**.</small></label>
        </section>

        <section class="card" id="adminsCard">${adminsHTML()}</section>

        <section class="card span-2">
          <div class="card-head">
            <h2>Sessies (${SESSIES.length})</h2>
            <div class="inline">
              <input type="search" id="beheerZoek" placeholder="Zoek sessie…" value="${esc(beheerZoek)}" style="max-width:260px">
              <button class="btn pink" data-new>+ Nieuwe sessie</button>
            </div>
          </div>
          <div class="tbl-scroll">
            <table class="tbl">
              <thead><tr><th>Tijd</th><th>Zaal</th><th>Titel</th><th>Type</th><th>Spreker</th><th>Uitleg</th><th></th></tr></thead>
              <tbody>${lijst.map(s => `
                <tr>
                  <td class="nowrap">${fmt(s.start)}–${fmt(s.eind)}</td>
                  <td class="nowrap">${esc(s.zaal)}</td>
                  <td><b>${esc(s.titel)}</b></td>
                  <td class="nowrap"><span class="swatch" style="${kleurVars(s.type)}"></span>${esc(s.type)}</td>
                  <td>${esc(s.spreker)}</td>
                  <td class="nowrap" title="Uitleg / foto / video">${[s.samenvatting || s.beschrijving ? '📝' : '', s.fotoId ? '📷' : '', s.video ? '🎬' : ''].join(' ').trim() || '<span class="hint">–</span>'}</td>
                  <td class="nowrap"><button class="btn small ghost" data-edit="${s.id}">Bewerken</button>
                    <button class="icon-btn" data-del="${s.id}" title="Verwijderen">✕</button></td>
                </tr>`).join('') || '<tr><td colspan="7" class="empty">Geen sessies.</td></tr>'}
              </tbody>
            </table>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h2>Zalen</h2><button class="btn small" data-addzaal>+ Zaal</button></div>
          <table class="tbl">
            <thead><tr><th>Naam</th><th>Plaatsen</th><th>Sessies</th><th></th></tr></thead>
            <tbody>${data.zalen.map((z, idx) => {
              const n = data.sessies.filter(s => s.zaal === z.naam).length;
              return `<tr>
                <td><input type="text" data-zaal="${idx}" data-field="naam" value="${esc(z.naam)}"></td>
                <td style="width:100px"><input type="number" min="0" data-zaal="${idx}" data-field="capaciteit" value="${z.capaciteit ?? ''}"></td>
                <td>${n}</td>
                <td><button class="icon-btn" data-delzaal="${idx}" title="${n ? 'Zaal heeft nog sessies' : 'Verwijderen'}" ${n ? 'disabled' : ''}>✕</button></td>
              </tr>`; }).join('')}
            </tbody>
          </table>
        </section>

        <section class="card">
          <div class="card-head"><h2>Sessietypes</h2><button class="btn small" data-addtype>+ Type</button></div>
          <table class="tbl">
            <thead><tr><th>Naam</th><th>Kleur</th><th>Uitleg voor bezoekers</th><th></th></tr></thead>
            <tbody>${data.typen.map((t, idx) => {
              const n = data.sessies.filter(s => s.type === t.naam).length;
              return `<tr>
                <td style="width:30%"><input type="text" data-typ="${idx}" data-field="naam" value="${esc(t.naam)}"></td>
                <td style="width:130px"><select data-typ="${idx}" data-field="kleur">${Object.entries(PALET).map(([k, p]) => `<option value="${k}" ${k === t.kleur ? 'selected' : ''}>${p.naam}</option>`).join('')}</select></td>
                <td><textarea data-typ="${idx}" data-field="uitleg" rows="2" style="min-height:0">${esc(t.uitleg)}</textarea></td>
                <td><button class="icon-btn" data-deltype="${idx}" ${n ? 'disabled title="Type is nog in gebruik"' : 'title="Verwijderen"'}>✕</button></td>
              </tr>`; }).join('')}
            </tbody>
          </table>
        </section>

        <section class="card span-2">
          <div class="card-head">
            <h2>Sprekers (${data.sprekers.length})</h2>
            <div class="inline">
              <button class="btn small" data-sprekersaanvullen title="Maakt een kopje aan voor elke spreker in het programma die er nog geen heeft">Ontbrekende sprekers aanmaken</button>
              <button class="btn small" data-addspreker>+ Spreker</button>
            </div>
          </div>
          <p class="hint">De teksten zijn een eerste opzet op basis van openbare bronnen. <b>Concept</b> = weinig online gevonden, aanvullen met info van de spreker. <b>Controleren</b> = check of de bron over dezelfde persoon gaat. Zet de status op <b>Gecontroleerd</b> als de tekst klopt. Het veld "Koppelen aan" bepaalt bij welke sessies de spreker hoort (tekst die in het sprekersveld van de sessie voorkomt).</p>
          <div class="tbl-scroll">
            <table class="tbl">
              <thead><tr><th>Spreker</th><th>Tekst</th><th>Status &amp; bronnen</th><th></th></tr></thead>
              <tbody>${[...data.sprekers].map((x, idx) => ({ x, idx })).sort((a, b) => a.x.naam.localeCompare(b.x.naam, 'nl')).map(({ x, idx }) => {
                const n = SESSIES.filter(s => norm(s.spreker).includes(norm(x.zoek))).length;
                return `<tr>
                  <td style="width:22%">
                    <input type="text" data-spr="${idx}" data-field="naam" value="${esc(x.naam)}" title="Naam">
                    <input type="text" data-spr="${idx}" data-field="organisatie" value="${esc(x.organisatie)}" placeholder="Organisatie" style="margin-top:4px">
                    <label class="hint" style="display:block;margin-top:4px">Koppelen aan<input type="text" data-spr="${idx}" data-field="zoek" value="${esc(x.zoek)}"></label>
                    <span class="hint">${n} sessie(s)</span>
                  </td>
                  <td><textarea data-spr="${idx}" data-field="bio" rows="5">${esc(x.bio)}</textarea></td>
                  <td style="width:20%">
                    <select data-spr="${idx}" data-field="status">
                      ${[['concept', 'Concept'], ['controleren', 'Controleren'], ['bron', 'Met bron'], ['gecontroleerd', 'Gecontroleerd']].map(([k, l]) => `<option value="${k}" ${x.status === k ? 'selected' : ''}>${l}</option>`).join('')}
                    </select>
                    <span class="status st-${esc(x.status)}"></span>
                    ${(x.bronnen || []).map((u, i) => `<div><a href="${esc(u)}" target="_blank" rel="noopener" class="hint">bron ${i + 1}</a></div>`).join('')}
                  </td>
                  <td><button class="icon-btn" data-delspreker="${idx}" title="Verwijderen">✕</button></td>
                </tr>`; }).join('')}
              </tbody>
            </table>
          </div>
        </section>

        <section class="card span-2">
          <h2>Back-up</h2>
          <p class="hint">Download het volledige programma als bestand, of zet een eerder bewaard bestand terug.</p>
          <div class="inline">
            <button class="btn" data-export>💾 Download back-up</button>
            <button class="btn" data-import>📂 Back-up terugzetten</button>
            <input type="file" id="importFile" accept=".json,application/json" hidden>
          </div>
        </section>
      </div>`;
    const sel = $('#sessionTypeHelper'); if (sel) sel.innerHTML = typeOpts('');
  }

  function adminsHTML() {
    if (!Cloud.enabled) return '<h2>Beheerders</h2><p class="hint">Beheerders toevoegen kan alleen in de online versie.</p>';
    const me = Cloud.user()?.email?.toLowerCase();
    const list = Object.entries(Cloud.admins() || {}).sort((a, b) => a[1].email.localeCompare(b[1].email));
    return `
      <h2>Beheerders</h2>
      <p class="hint">Beheerders loggen in met Google en kunnen daarna het programma, de sessies en de zalen aanpassen. Vul het Gmail-adres in (of een ander adres met een Google-account).</p>
      ${Cloud.adminsError() ? '<div class="alert">De beheerderslijst is nog niet beschikbaar: de databaseregels in Firebase moeten eerst worden bijgewerkt.</div>' : ''}
      ${Cloud.admins() ? `
        <ul class="admins">
          ${list.length ? list.map(([key, a]) => `
            <li><span>${esc(a.email)}${a.email === me ? ' <span class="pill">jij</span>' : ''}</span>
              <button class="icon-btn" data-deladmin="${esc(key)}" title="Verwijder als beheerder">✕</button></li>`).join('')
            : '<li class="hint">Nog geen extra beheerders.</li>'}
        </ul>
        <div class="inline">
          <input type="email" id="newAdmin" placeholder="naam@gmail.com" autocomplete="off">
          <button class="btn primary" data-addadmin>Toevoegen</button>
        </div>
        <p class="hint" style="margin-top:8px">De eigenaar staat vast in de databaseregels en heeft altijd toegang.</p>` : ''}`;
  }

  function addAdmin() {
    const input = $('#newAdmin');
    const email = input.value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { alert('Vul een geldig e-mailadres in, bijvoorbeeld naam@gmail.com.'); input.focus(); return; }
    if (Cloud.admins()?.[Cloud.emailKey(email)]) { alert(`${email} is al beheerder.`); return; }
    Cloud.addAdmin(email).then(() => { input.value = ''; toast(`${email} is nu beheerder`); })
      .catch(e => alert('Toevoegen is niet gelukt: ' + e.message));
  }

  const UITLEG_VELDEN = ['samenvatting', 'beschrijving', 'doelgroep', 'sprekerInfo', 'video', 'fotoId', 'fotoAlt'];
  let editFoto = null; // null = ongewijzigd, 'weg' = verwijderen, anders de nieuwe foto (data-URL)

  function openEditor(id, kopie = false) {
    const bron = id ? data.sessies.find(s => s.id === id) : null;
    const leeg = { id: '', zaal: data.zalen[0]?.naam || '', start: '11:00', eind: '12:00', titel: '', type: data.typen[0]?.naam || '', spreker: '' };
    const s = { ...leeg, ...Object.fromEntries(UITLEG_VELDEN.map(k => [k, ''])), ...(bron || {}) };
    if (kopie) s.id = '';
    editFoto = null;
    openId = null;
    const sleutel = x => norm(x.titel + '|' + x.spreker);
    const zusjes = bron ? data.sessies.filter(x => x.id !== bron.id && sleutel(x) === sleutel(bron)) : [];
    $('#modal-content').innerHTML = `
      <form id="editForm" class="m-body" style="padding-top:22px" novalidate>
        <div class="card-head"><h2 style="margin:0">${s.id ? 'Sessie bewerken' : kopie ? 'Sessie op een ander tijdstip' : 'Nieuwe sessie'}</h2>
          <button type="button" class="m-close" data-close aria-label="Sluiten" style="position:static">✕</button></div>

        <h3 class="ed-h">Praktisch</h3>
        <label class="field">Titel<input type="text" name="titel" required value="${esc(s.titel)}"></label>
        <div class="two">
          <label class="field">Type<select name="type">${data.typen.map(t => `<option ${t.naam === s.type ? 'selected' : ''}>${esc(t.naam)}</option>`).join('')}</select></label>
          <label class="field">Zaal<select name="zaal">${data.zalen.map(z => `<option ${z.naam === s.zaal ? 'selected' : ''}>${esc(z.naam)}</option>`).join('')}</select></label>
        </div>
        <div class="two">
          <label class="field">Begintijd<input type="time" name="start" step="300" required value="${esc(s.start.padStart(5, '0'))}"></label>
          <label class="field">Eindtijd<input type="time" name="eind" step="300" required value="${esc(s.eind.padStart(5, '0'))}"></label>
        </div>
        <label class="field">Spreker / organisatie<input type="text" name="spreker" value="${esc(s.spreker)}"></label>

        <h3 class="ed-h">Uitleg voor bezoekers</h3>
        <label class="field">Korte samenvatting <small class="hint">(1–2 zinnen, zichtbaar in het overzicht)</small>
          <textarea name="samenvatting" rows="2" maxlength="300" style="min-height:0">${esc(s.samenvatting)}</textarea></label>
        <label class="field">Uitgebreide beschrijving
          <textarea name="beschrijving" rows="8" placeholder="Waar gaat de sessie over, hoe ziet hij eruit en wat neem je mee naar je klas?">${esc(s.beschrijving)}</textarea>
          <small class="hint">Opmaak: lege regel = nieuwe alinea · regel beginnen met "- " = opsomming · **vet** · links worden klikbaar.</small></label>
        <label class="field">Voor wie is deze sessie? <textarea name="doelgroep" rows="2" style="min-height:0" placeholder="Bijvoorbeeld: leerkrachten groep 1-3, intern begeleiders">${esc(s.doelgroep)}</textarea></label>
        <label class="field">Over de spreker <textarea name="sprekerInfo" rows="3" style="min-height:0">${esc(s.sprekerInfo)}</textarea></label>

        <h3 class="ed-h">Foto en video</h3>
        <div class="media-edit">
          <div class="foto-preview" id="fotoPreview"><span class="hint">Geen foto</span></div>
          <div>
            <label class="btn ghost small" style="cursor:pointer">📷 Foto kiezen<input type="file" id="fotoInput" accept="image/*" hidden></label>
            <button type="button" class="btn ghost small danger" id="fotoWeg" ${s.fotoId ? '' : 'hidden'}>Foto verwijderen</button>
            <p class="hint" style="margin-top:6px">JPG of PNG. Grote foto's worden automatisch verkleind. Gebruik alleen foto's waarvoor toestemming is (AVG).</p>
            <label class="field">Omschrijving van de foto <small class="hint">(voor schermlezers)</small><input type="text" name="fotoAlt" value="${esc(s.fotoAlt)}"></label>
          </div>
        </div>
        <label class="field">Video <small class="hint">(link naar YouTube of Vimeo)</small><input type="url" name="video" placeholder="https://www.youtube.com/watch?v=…" value="${esc(s.video)}"></label>
        <div id="videoCheck" class="hint"></div>

        ${zusjes.length ? `<label class="switch" style="margin:10px 0"><input type="checkbox" name="sync" checked>
          Uitleg, foto en video ook gebruiken voor ${zusjes.length === 1 ? 'het andere tijdstip' : `de ${zusjes.length} andere tijdstippen`} van deze sessie (${zusjes.map(z => z.start).join(', ')})</label>` : ''}
        <p class="warn" id="editWarn"></p>
        <div class="inline" style="justify-content:space-between">
          <div class="inline">
            <button type="submit" class="btn primary" id="editSave">Opslaan</button>
            <button type="button" class="btn ghost" data-close>Annuleren</button>
          </div>
          ${s.id ? `<div class="inline"><button type="button" class="btn ghost" data-copy="${s.id}">Kopie op ander tijdstip</button>
            <button type="button" class="btn danger" data-del="${s.id}">Verwijderen</button></div>` : ''}
        </div>
      </form>`;
    $('#modal').classList.add('wide');
    if (!$('#modal').open) $('#modal').showModal();
    const form = $('#editForm');
    form.titel.focus();

    const toonFoto = src => {
      $('#fotoPreview').innerHTML = src ? `<img src="${src}" alt="">` : '<span class="hint">Geen foto</span>';
      $('#fotoWeg').hidden = !src;
    };
    if (s.fotoId) { $('#fotoPreview').innerHTML = '<span class="hint">Laden…</span>'; loadFoto(s.fotoId).then(src => { if (editFoto === null) toonFoto(src); }); }
    $('#fotoInput').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      $('#fotoPreview').innerHTML = '<span class="hint">Verkleinen…</span>';
      try { editFoto = await comprimeer(file); toonFoto(editFoto); }
      catch (err) { alert(err.message); toonFoto(null); }
      e.target.value = '';
    });
    $('#fotoWeg').addEventListener('click', () => { editFoto = 'weg'; toonFoto(null); });
    const checkVideo = () => {
      const v = form.video.value.trim();
      $('#videoCheck').innerHTML = !v ? '' : videoEmbed(v) ? '<span class="saved">✓ Video herkend</span>' : '<span class="warn">Dit is geen YouTube- of Vimeo-link.</span>';
    };
    form.video.addEventListener('input', checkVideo); checkVideo();

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      const sync = !!f.sync; delete f.sync;
      Object.keys(f).forEach(k => { f[k] = String(f[k]).trim(); });
      f.start = f.start.replace(/^0(\d)/, '$1'); f.eind = f.eind.replace(/^0(\d)/, '$1');
      const warn = $('#editWarn');
      if (!f.titel) { warn.textContent = 'Vul een titel in.'; return; }
      if (!validTime(f.start) || !validTime(f.eind) || toMin(f.eind) <= toMin(f.start)) { warn.textContent = 'De eindtijd moet na de begintijd liggen.'; return; }
      if (f.video && !videoEmbed(f.video)) { warn.textContent = 'Gebruik een link naar YouTube of Vimeo, of laat het videoveld leeg.'; return; }
      const botst = data.sessies.find(x => x.id !== s.id && x.zaal === f.zaal && toMin(x.start) < toMin(f.eind) && toMin(f.start) < toMin(x.eind));
      if (botst && !confirm(`${f.zaal} is dan al bezet door "${botst.titel}" (${botst.start}–${botst.eind}). Toch opslaan?`)) return;

      const oudeFotos = [s.fotoId, ...(sync ? zusjes.map(z => z.fotoId) : [])];
      f.fotoId = s.fotoId || '';
      if (editFoto === 'weg') f.fotoId = '';
      else if (editFoto) {
        const btn = $('#editSave'); btn.disabled = true; btn.textContent = 'Foto opslaan…';
        try { f.fotoId = 'f' + newId(); await saveFoto(f.fotoId, editFoto); }
        catch (err) { btn.disabled = false; btn.textContent = 'Opslaan'; warn.textContent = 'De foto kon niet worden opgeslagen: ' + err.message; return; }
      }
      wijzig(d => {
        if (s.id) Object.assign(d.sessies.find(x => x.id === s.id), f);
        else d.sessies.push({ id: newId(), ...f });
        if (sync) zusjes.forEach(z => { const t = d.sessies.find(x => x.id === z.id); if (t) UITLEG_VELDEN.forEach(k => { t[k] = f[k]; }); });
      }, s.id ? 'Sessie opgeslagen' : 'Sessie toegevoegd');
      opruimenFotos(oudeFotos);
      $('#modal').close();
    });
  }

  async function exportBackup() {
    const media = {};
    for (const id of new Set(data.sessies.map(x => x.fotoId).filter(Boolean))) media[id] = await loadFoto(id);
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([JSON.stringify({ ...data, media }, null, 1)], { type: 'application/json' })),
      download: `congresprogramma-${new Date().toISOString().slice(0, 10)}.json`,
    });
    a.click();
  }

  function importBackup(file) {
    file.text().then(async t => {
      const raw = JSON.parse(t);
      const media = raw.media || {}; delete raw.media;
      const d = normalize(raw);
      if (!d.sessies.length && !confirm('Dit bestand bevat geen sessies. Toch terugzetten?')) return;
      if (!confirm(`Het huidige programma vervangen door dit bestand (${d.sessies.length} sessies)?`)) return;
      for (const [id, src] of Object.entries(media)) if (src) await saveFoto(id, src).catch(() => {});
      const oud = data.sessies.map(x => x.fotoId);
      wijzig(() => { data = d; }, 'Back-up teruggezet');
      opruimenFotos(oud);
    }).catch(e => alert('Dit bestand kan niet worden gelezen: ' + e.message));
  }

  /* ===================== Gebeurtenissen ===================== */
  document.addEventListener('click', e => {
    const t = e.target.closest('button, [data-view]');
    if (!t) { if (e.target === $('#modal')) $('#modal').close(); return; }
    const d = t.dataset;
    if (d.toggle) return toggle(d.toggle);
    if (d.replace) return toggle(d.replace, { vervang: true });
    if (d.open) return openDetail(d.open);
    if ('close' in d) return $('#modal').close();
    if (d.type) { filter.types.has(d.type) ? filter.types.delete(d.type) : filter.types.add(d.type); return render(); }
    if (d.spreker) {
      $('#modal').close(); view = 'sprekers'; sprekerZoek = ''; render();
      const x = data.sprekers.find(y => y.naam === d.spreker);
      const el = x && document.getElementById(sprekerAnker(x));
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
      return;
    }
    if (d.view) { view = d.view; history.replaceState(null, '', '#' + view); window.scrollTo({ top: 0 }); return render(); }
    if (d.attime) { $('#modal').close(); filter.at = d.attime; view = 'list'; render(); $('#at').value = filter.at; return; }
    if ('clearwin' in d) { filter.win = null; return render(); }
    if (d.gap) {
      filter.win = d.gap.split('-').map(Number); filter.at = ''; $('#at').value = '';
      filter.fits = true; $('#fits').checked = true; view = 'list'; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); return;
    }
    if (d.action === 'signin') return Cloud.signIn();
    if (d.action === 'signout') return Cloud.signOut();
    // beheer
    if ('new' in d) return openEditor(null);
    if (d.edit) return openEditor(d.edit);
    if (d.copy) return openEditor(d.copy, true);
    if (d.del) {
      const s = data.sessies.find(x => x.id === d.del);
      if (s && confirm(`"${s.titel}" (${s.start}–${s.eind}, ${s.zaal}) verwijderen?`)) {
        if ($('#modal').open) $('#modal').close();
        wijzig(dd => { dd.sessies = dd.sessies.filter(x => x.id !== s.id); }, 'Sessie verwijderd');
        opruimenFotos([s.fotoId]);
      }
      return;
    }
    if ('addzaal' in d) return wijzig(dd => { dd.zalen.push({ naam: `Nieuwe zaal ${dd.zalen.length + 1}`, capaciteit: null }); }, 'Zaal toegevoegd');
    if (d.delzaal) return wijzig(dd => { dd.zalen.splice(+d.delzaal, 1); }, 'Zaal verwijderd');
    if ('addtype' in d) return wijzig(dd => { dd.typen.push({ naam: `Nieuw type ${dd.typen.length + 1}`, kleur: 'blauw', uitleg: '' }); }, 'Type toegevoegd');
    if (d.deltype) return wijzig(dd => { dd.typen.splice(+d.deltype, 1); }, 'Type verwijderd');
    if ('addadmin' in d) return addAdmin();
    if (d.deladmin) {
      const a = Cloud.admins()?.[d.deladmin];
      if (a && confirm(`${a.email} verwijderen als beheerder?`)) Cloud.removeAdmin(d.deladmin).catch(err => alert('Verwijderen is niet gelukt: ' + err.message));
      return;
    }
    if ('addspreker' in d) return wijzig(dd => { dd.sprekers.push({ naam: 'Nieuwe spreker', zoek: 'Nieuwe spreker', organisatie: '', status: 'concept', bio: '', bronnen: [] }); }, 'Spreker toegevoegd');
    if (d.delspreker) {
      const x = data.sprekers[+d.delspreker];
      if (x && confirm(`Het kopje voor ${x.naam} verwijderen?`)) wijzig(dd => { dd.sprekers.splice(+d.delspreker, 1); }, 'Spreker verwijderd');
      return;
    }
    if ('sprekersaanvullen' in d) {
      const nieuw = [...new Set(data.sessies.map(s => s.spreker).filter(Boolean))]
        .filter(sp => !data.sprekers.some(x => norm(sp).includes(norm(x.zoek))));
      if (!nieuw.length) return toast('Alle sprekers hebben al een kopje');
      return wijzig(dd => nieuw.forEach(sp => dd.sprekers.push({ naam: sp, zoek: sp, organisatie: '', status: 'concept', bio: '', bronnen: [] })), `${nieuw.length} spreker(s) aangemaakt`);
    }
    if ('export' in d) return exportBackup();
    if ('import' in d) return $('#importFile').click();
    if ('publish' in d) return wijzig(() => {}, 'Programma staat online');
  });

  // Beheervelden: opslaan bij verlaten van het veld.
  document.addEventListener('change', e => {
    const el = e.target, d = el.dataset;
    if (el.id === 'importFile' && el.files[0]) { importBackup(el.files[0]); el.value = ''; return; }
    if (d.info) return wijzig(dd => { dd.info[d.info] = el.value.trim(); }, 'Opgeslagen');
    if (d.zaal) {
      const idx = +d.zaal, old = data.zalen[idx].naam;
      if (d.field === 'naam') {
        const nieuw = el.value.trim();
        if (!nieuw || (nieuw !== old && data.zalen.some(z => z.naam === nieuw))) { alert('Kies een unieke, niet-lege zaalnaam.'); el.value = old; return; }
        return wijzig(dd => { dd.zalen[idx].naam = nieuw; dd.sessies.forEach(s => { if (s.zaal === old) s.zaal = nieuw; }); }, 'Zaal hernoemd');
      }
      return wijzig(dd => { dd.zalen[idx].capaciteit = el.value === '' ? null : Math.max(0, +el.value); }, 'Opgeslagen');
    }
    if (d.spr) {
      const idx = +d.spr;
      return wijzig(dd => { dd.sprekers[idx][d.field] = el.value.trim(); if (d.field === 'naam' && !dd.sprekers[idx].zoek) dd.sprekers[idx].zoek = el.value.trim(); }, 'Opgeslagen');
    }
    if (d.typ) {
      const idx = +d.typ, old = data.typen[idx].naam;
      if (d.field === 'naam') {
        const nieuw = el.value.trim();
        if (!nieuw || (nieuw !== old && data.typen.some(t => t.naam === nieuw))) { alert('Kies een unieke, niet-lege naam.'); el.value = old; return; }
        return wijzig(dd => { dd.typen[idx].naam = nieuw; dd.sessies.forEach(s => { if (s.type === old) s.type = nieuw; }); }, 'Type hernoemd');
      }
      return wijzig(dd => { dd.typen[idx][d.field] = el.value.trim(); }, 'Opgeslagen');
    }
  });

  document.addEventListener('input', e => {
    if (e.target.id === 'beheerZoek') {
      beheerZoek = e.target.value;
      const pos = e.target.selectionStart;
      e.target.blur(); renderBeheer();
      const n = $('#beheerZoek'); n.focus(); n.setSelectionRange(pos, pos);
    }
  });
  document.addEventListener('input', e => {
    if (e.target.id === 'sprekerZoek') { sprekerZoek = e.target.value; renderSprekers(); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id === 'newAdmin') { e.preventDefault(); addAdmin(); }
  });

  $('#modal').addEventListener('close', () => { openId = null; });
  $('#q').addEventListener('input', e => { filter.q = norm(e.target.value.trim()); renderGrid(); renderList(); });
  $('#at').addEventListener('change', e => { filter.at = e.target.value; render(); });
  $('#dur').addEventListener('change', e => { filter.dur = e.target.value; render(); });
  $('#fits').addEventListener('change', e => { filter.fits = e.target.checked; render(); });
  $('#reset').addEventListener('click', () => {
    Object.assign(filter, { q: '', at: '', dur: '', fits: false, win: null }); filter.types.clear();
    $('#q').value = ''; $('#at').value = ''; $('#dur').value = ''; $('#fits').checked = false; render();
  });

  /* Delen, afdrukken, agenda */
  $('#share').addEventListener('click', async () => {
    if (!mijnSessies().length) return toast('Voeg eerst sessies toe aan je schema');
    const u = new URL(location.href); u.hash = 'schema=' + mijnSessies().map(s => s.id).join(',');
    try { await navigator.clipboard.writeText(u.toString()); toast('Deellink gekopieerd!'); }
    catch { prompt('Kopieer deze link:', u.toString()); }
  });
  $('#print').addEventListener('click', () => window.print());
  /* PDF van het persoonlijke schema (echt bestand, ook offline te bewaren) */
  const loadScript = src => new Promise((res, rej) => {
    const el = Object.assign(document.createElement('script'), { src, onload: res, onerror: () => rej(new Error('Laden mislukt')) });
    document.head.appendChild(el);
  });

  async function downloadPdf() {
    const m = mijnSessies();
    if (!m.length) return toast('Voeg eerst sessies toe aan je schema');
    const btn = $('#pdf'); btn.disabled = true; btn.textContent = 'PDF maken…';
    try {
      for (const src of ['https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js']) {
        if (window.jspdf) break;
        await loadScript(src).catch(() => {});
      }
      if (!window.jspdf) throw new Error('PDF-onderdeel kon niet worden geladen');
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: 'mm', format: 'a4' });
      const W = 210, H = 297, L = 16, R = W - 16;
      const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
      const NAVY = hex('#2f335b'), PINK = hex('#c70a64'), BLUE = hex('#0090ad'), MUTED = hex('#6b6f8e'), TPINK = hex('#e9bfd1');
      const i = data.info;
      const datum = i.datum ? new Date(i.datum + 'T12:00').toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '';

      // Kop: donkerblauw vlak met vijfhoekige onderkant (huisstijl) en bordwisserstrepen
      const kop = () => {
        doc.setFillColor(...NAVY);
        doc.roundedRect(L - 4, 10, R - L + 8, 34, 4, 4, 'F');
        doc.triangle(L - 4, 40, R + 4, 40, W / 2, 48, 'F');
        doc.setFillColor(...TPINK);
        [0, 1, 2, 3].forEach(k => doc.roundedRect(R - 40 + k * 9, 15, 5.5, 24, 2.75, 2.75, 'F'));
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
        doc.text(i.naam, L + 2, 22, { maxWidth: R - L - 50 });
        doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5);
        doc.text(['Mijn schema', [datum, i.locatie].filter(Boolean).join(' · ')].filter(Boolean), L + 2, 30);
      };
      kop();
      let y = 58;
      const voet = () => {
        doc.setFontSize(8); doc.setTextColor(...MUTED);
        const nu = new Date().toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' });
        doc.text(`Gemaakt op ${nu}. Wijzigingen in het programma voorbehouden; actueel programma: ${location.origin + location.pathname}`, L, H - 10, { maxWidth: R - L - 30 });
      };

      const regel = (lines, size, style, color, x, yy) => { doc.setFont('helvetica', style); doc.setFontSize(size); doc.setTextColor(...color); doc.text(lines, x, yy); };
      let cursor = DAG_START;
      const vrij = (a, b) => {
        if (y > H - 30) { voet(); doc.addPage(); y = 20; }
        doc.setDrawColor(...hex('#d9e6ea')); doc.setLineDashPattern([1.2, 1.2], 0);
        doc.roundedRect(L + 24, y - 4, R - L - 24, 9, 2, 2, 'S'); doc.setLineDashPattern([], 0);
        regel(`Vrij: ${fmt(a)} – ${fmt(b)}`, 9, 'normal', MUTED, L + 28, y + 1.8);
        y += 13;
      };
      for (const s of m) {
        if (s.start > cursor) vrij(cursor, s.start);
        const p = PALET[typeInfo(s.type).kleur] || PALET.navy;
        const titel = doc.setFont('helvetica', 'bold').setFontSize(11.5).splitTextToSize(s.titel, R - L - 34);
        const meta = doc.setFont('helvetica', 'normal').setFontSize(9).splitTextToSize(`${s.zaal}${s.cap ? ` (${s.cap} pl.)` : ''}  ·  ${s.spreker}  ·  ${s.type}`, R - L - 34);
        const kort = (s.samenvatting || s.beschrijving || '').replace(/\*\*/g, '');
        const beschr = kort ? doc.setFontSize(8.5).splitTextToSize(kort, R - L - 34).slice(0, 4) : [];
        const h = 6 + titel.length * 5 + meta.length * 4.2 + (beschr.length ? 1.5 + beschr.length * 3.8 : 0) + 3;
        if (y + h > H - 22) { voet(); doc.addPage(); y = 20; }
        const b = botsingen(s).length;
        doc.setFillColor(...hex(p.bg)); doc.roundedRect(L + 24, y - 5, R - L - 24, h, 3, 3, 'F');
        doc.setFillColor(...hex(p.c)); doc.roundedRect(L + 24, y - 5, 2.5, h, 1.2, 1.2, 'F');
        if (b) { doc.setDrawColor(...PINK); doc.setLineWidth(.6); doc.roundedRect(L + 24, y - 5, R - L - 24, h, 3, 3, 'S'); doc.setLineWidth(.2); }
        regel(fmt(s.start), 12, 'bold', NAVY, L, y + 1);
        regel(fmt(s.eind), 9, 'normal', MUTED, L, y + 6);
        let yy = y + 1;
        regel(titel, 11.5, 'bold', NAVY, L + 30, yy); yy += titel.length * 5;
        regel(meta, 9, 'normal', BLUE, L + 30, yy); yy += meta.length * 4.2;
        if (beschr.length) { yy += 1.5; regel(beschr, 8.5, 'normal', MUTED, L + 30, yy); }
        if (b) regel('Let op: overlapt met een andere keuze', 8, 'bold', PINK, R - 58, y - 1);
        y += h + 4;
        cursor = Math.max(cursor, s.eind);
      }
      if (cursor < DAG_EIND) vrij(cursor, DAG_EIND);
      voet();
      const naam = 'mijn-schema-' + norm(i.naam).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.pdf';
      doc.save(naam);
      toast('PDF gedownload');
    } catch (e) {
      alert('De PDF kon niet worden gemaakt (' + e.message + '). Gebruik eventueel "Afdrukken / PDF".');
    } finally {
      btn.disabled = false; btn.textContent = '📄 Download als PDF';
    }
  }
  $('#pdf').addEventListener('click', downloadPdf);

  $('#clear').addEventListener('click', () => {
    if (mijn.size && confirm('Weet je zeker dat je je hele schema wilt leegmaken?')) { mijn.clear(); bewaarSchema(); render(); }
  });
  $('#ics').addEventListener('click', () => {
    const dag = data.info.datum.replace(/-/g, '');
    const t = m => `${dag}T${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}00`;
    const tx = s => String(s).replace(/[\\,;]/g, '\\$&').replace(/\n/g, '\\n');
    const ev = mijnSessies().map(s => ['BEGIN:VEVENT', `UID:${s.id}@congres-boor`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
      `DTSTART;TZID=Europe/Amsterdam:${t(s.start)}`, `DTEND;TZID=Europe/Amsterdam:${t(s.eind)}`,
      `SUMMARY:${tx(s.titel)}`, `LOCATION:${tx(s.zaal + (data.info.locatie ? ' – ' + data.info.locatie : ''))}`,
      `DESCRIPTION:${tx(s.type + ' door ' + s.spreker)}`, 'END:VEVENT'].join('\r\n'));
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//stichting BOOR//Congres//NL', ...ev, 'END:VCALENDAR'].join('\r\n');
    Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([ics], { type: 'text/calendar' })), download: 'mijn-congresschema.ics',
    }).click();
  });

  /* Gedeeld schema via link */
  function gedeeld() {
    const m = location.hash.match(/schema=([^&]*)/);
    if (!m) return;
    const ids = m[1].split(',').filter(id => BY_ID[id]);
    const bn = $('#shared-banner');
    if (!ids.length || (ids.length === mijn.size && ids.every(id => mijn.has(id)))) { bn.hidden = true; return; }
    bn.hidden = false;
    bn.innerHTML = `<span>📨 Je opent een gedeeld schema met <b>${ids.length} sessie(s)</b>: ${ids.slice(0, 3).map(id => esc(BY_ID[id].titel)).join(', ')}${ids.length > 3 ? '…' : ''}</span>
      <button class="btn primary small" id="sh-take">Overnemen als mijn schema</button>
      <button class="btn small" id="sh-merge">Toevoegen aan mijn schema</button>
      <button class="linkbtn" id="sh-no">Negeren</button>`;
    const klaar = msg => { bn.hidden = true; history.replaceState(null, '', location.pathname + location.search + '#my'); bewaarSchema(); view = 'my'; render(); toast(msg); };
    $('#sh-take').onclick = () => { mijn = new Set(ids); klaar('Schema overgenomen'); };
    $('#sh-merge').onclick = () => { ids.forEach(id => mijn.add(id)); klaar('Sessies toegevoegd'); };
    $('#sh-no').onclick = () => { bn.hidden = true; history.replaceState(null, '', location.pathname + location.search); };
  }

  // Kopbalk verbergen bij naar beneden scrollen, terug bij omhoog scrollen.
  let lastY = window.scrollY;
  window.addEventListener('scroll', () => {
    const y = window.scrollY, bar = $('.topbar');
    if (y > lastY + 6 && y > bar.offsetHeight) bar.classList.add('bar-hidden');
    else if (y < lastY - 6 || y < 20) bar.classList.remove('bar-hidden');
    lastY = y;
  }, { passive: true });

  /* ===================== Start ===================== */
  const startView = location.hash.slice(1);
  if (['grid', 'list', 'sprekers', 'over', 'my', 'beheer'].includes(startView)) view = startView;

  Cloud.init({
    onData(d) {
      data = normalize(d || clone(window.STANDAARD_PROGRAMMA));
      prepare(); renderTimes(); render(); gedeeld();
    },
    onAuth() {
      if (Cloud.canEdit() && location.hash === '#beheer') view = 'beheer';
      render();
    },
    onAdmins() { const c = $('#adminsCard'); if (c && !c.contains(document.activeElement)) c.innerHTML = adminsHTML(); },
    onDenied(email) { alert(`Je bent ingelogd als ${email}, maar dit account is geen beheerder van het congres. Vraag een beheerder om je Gmail-adres toe te voegen.`); },
    onStatus() { renderCloud(); renderBeheer(); },
    onSaved() {},
    onError(e) { alert('Opslaan online is mislukt: ' + (e.message || e) + '\nControleer je internetverbinding en of je nog beheerder bent.'); },
  });

  prepare(); renderTimes(); render(); gedeeld();
})();
