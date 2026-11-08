// Online opslag van het congresprogramma via dezelfde Firebase Realtime Database als het padeltoernooi.
// Iedereen mag het programma lezen; alleen congresbeheerders (en de eigenaar uit de databaseregels)
// mogen het wijzigen. Zonder Firebase (file://, ?lokaal) werkt de site lokaal in deze browser.
//
// Opslag:
//   /congres/data        – het hele programma als JSON-tekst
//   /congres/updatedAt   – servertijd van de laatste wijziging
//   /congresMedia/{id}   – foto's (JPEG als data-URL), los geladen per sessie
//   /congresLogin/{e-mail} – wordt geschreven bij inloggen om te testen of iemand beheerder is (niet openbaar)
//   /congresBeheer/{e-mail met punten als komma's} = {email, addedBy, at}
const Cloud = (() => {
  const firebaseConfig = {
    apiKey: 'AIzaSyBLeT-wnwCUv_jU4W7Uo0mI6bs040d_TOQ',
    authDomain: 'padeltournooi.firebaseapp.com',
    databaseURL: 'https://padeltournooi-default-rtdb.europe-west1.firebasedatabase.app',
    projectId: 'padeltournooi',
    storageBucket: 'padeltournooi.firebasestorage.app',
    messagingSenderId: '248661724675',
    appId: '1:248661724675:web:cce9e7659970cdbebd0836',
  };

  const enabled = typeof firebase !== 'undefined'
    && location.protocol !== 'file:'
    && !new URLSearchParams(location.search).has('lokaal');

  let root = null, auth = null, user = null, editor = false;
  let status = enabled ? 'connecting' : 'local';
  let lastData = null, pending = null, timer = null, remoteEmpty = false, live = false, lastFetch = 0;
  let handlers = {};
  let adminsRef = null, admins = null, adminsError = null;
  let logRef = null, logEntries = null, logError = null;

  const emailKey = email => String(email).trim().toLowerCase().replace(/\./g, ',');

  function init(h) {
    handlers = h;
    if (!enabled) return;
    firebase.initializeApp(firebaseConfig);
    auth = firebase.auth();
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});
    // Terugkomst na inloggen via doorsturen: eventuele fout tonen.
    auth.getRedirectResult().catch(authFout);
    root = firebase.database().ref('congres');

    // Bezoekers halen het programma op met een gewone HTTP-aanvraag (geen blijvende verbinding),
    // zodat duizenden bezoekers binnen de 100 gelijktijdige verbindingen van het gratis plan blijven.
    // Alleen ingelogde beheerders krijgen een live-verbinding.
    fetchPublic();
    setInterval(() => { if (!live && document.visibilityState === 'visible') fetchPublic(); }, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (!live && document.visibilityState === 'visible' && Date.now() - lastFetch > 60 * 1000) fetchPublic();
    });

    auth.onAuthStateChanged(async u => {
      user = u;
      editor = false;
      stopAdmins();
      stopLog();
      stopLive();
      if (u) {
        try {
          await firebase.database().ref('congresLogin/' + emailKey(u.email)).set(firebase.database.ServerValue.TIMESTAMP);
          editor = true;
          watchLive();
          watchAdmins();
          watchLog();
          log('Ingelogd', '');
        } catch (e) {
          handlers.onDenied(u.email, e);
        }
      }
      handlers.onAuth();
    });
  }

  function apply(str) {
    remoteEmpty = !str;
    if (pending || (str && str === lastData)) { handlers.onStatus(); return; }
    let data = null;
    try { data = str ? JSON.parse(str) : null; } catch (e) { console.warn('Online programma onleesbaar', e); }
    lastData = str || null;
    handlers.onData(data);
  }

  function fetchPublic() {
    lastFetch = Date.now();
    fetch(firebaseConfig.databaseURL + '/congres/data.json', { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(str => { status = 'live'; apply(str); })
      .catch(err => {
        console.warn('Online programma niet leesbaar:', err.message);
        if (status !== 'live') status = 'error';
        handlers.onStatus();
      });
  }

  function watchLive() {
    live = true;
    root.child('data').on('value', snap => { status = 'live'; apply(snap.val()); }, err => {
      console.warn('Live-verbinding mislukt:', err.message);
    });
  }

  function stopLive() {
    if (live) root.child('data').off();
    live = false;
  }

  function watchAdmins() {
    adminsRef = firebase.database().ref('congresBeheer');
    adminsRef.on('value', snap => {
      admins = snap.val() || {};
      adminsError = null;
      handlers.onAdmins();
    }, err => {
      admins = null;
      adminsError = err;
      handlers.onAdmins();
    });
  }

  // Logboek: /congresLog/{push-id} = {at, email, action, detail}. Tijd en e-mail worden door de
  // databaseregels gecontroleerd; regels kunnen alleen worden toegevoegd, niet gewijzigd of gewist.
  function watchLog() {
    logRef = firebase.database().ref('congresLog').limitToLast(500);
    logRef.on('value', snap => {
      const list = [];
      snap.forEach(c => { list.push(c.val()); });
      logEntries = list.reverse();
      logError = null;
      handlers.onLog?.();
    }, err => {
      logEntries = null; logError = err;
      handlers.onLog?.();
    });
  }

  function stopLog() {
    if (logRef) logRef.off();
    logRef = null; logEntries = null; logError = null;
  }

  function log(action, detail) {
    if (!enabled || !editor || !user?.email) return;
    firebase.database().ref('congresLog').push({
      at: firebase.database.ServerValue.TIMESTAMP,
      email: user.email.toLowerCase(),
      action: String(action).slice(0, 100),
      detail: String(detail || '').slice(0, 480),
    }).catch(e => console.warn('Logboek bijwerken mislukt:', e.message));
  }

  function stopAdmins() {
    if (adminsRef) adminsRef.off();
    adminsRef = null; admins = null; adminsError = null;
  }

  function addAdmin(email) {
    email = String(email).trim().toLowerCase();
    return firebase.database().ref('congresBeheer/' + emailKey(email)).set({
      email, addedBy: user?.email || null, at: firebase.database.ServerValue.TIMESTAMP,
    });
  }

  function removeAdmin(key) {
    return firebase.database().ref('congresBeheer/' + key).remove();
  }

  // Foto's: los opgeslagen onder /congresMedia/{id} als data-URL; bezoekers halen ze op met een HTTP-aanvraag.
  function getMedia(id) {
    return fetch(firebaseConfig.databaseURL + '/congresMedia/' + encodeURIComponent(id) + '.json')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  function setMedia(id, src) {
    return firebase.database().ref('congresMedia/' + id).set(src || null);
  }

  // Uitleg bij de meest voorkomende inlogfouten.
  function authFout(e) {
    const uitleg = {
      'auth/unauthorized-domain': 'Dit webadres staat niet in de lijst met toegestane domeinen in Firebase (Authentication → Settings → Authorized domains). Voeg ' + location.hostname + ' daar toe.',
      'auth/operation-not-allowed': 'Inloggen met Google staat uit in Firebase (Authentication → Sign-in method → Google).',
      'auth/network-request-failed': 'Er is geen verbinding met Google. Controleer je internetverbinding of een adblocker/privacy-extensie.',
      'auth/web-storage-unsupported': 'Je browser blokkeert opslag die nodig is om in te loggen (bijvoorbeeld een privévenster of strenge cookie-instellingen).',
      'auth/internal-error': 'Google gaf een interne fout. Probeer het opnieuw of gebruik een andere browser.',
    }[e.code] || '';
    alert('Inloggen is niet gelukt.\n\n' + (uitleg ? uitleg + '\n\n' : '') + 'Foutcode: ' + (e.code || 'onbekend') + '\n' + (e.message || e));
  }

  // Inloggen met Google's eigen knop (Google Identity Services). Dit werkt rechtstreeks met deze site,
  // zonder het tussenvenster op firebaseapp.com dat Safari en Chrome blokkeren tussen websites.
  // Vereist: https://martklauw.github.io staat bij "Geautoriseerde JavaScript-bronnen" van deze client.
  const GOOGLE_CLIENT_ID = '248661724675-9urcqibc5ool73upbvl5gqts23jg016h.apps.googleusercontent.com';
  let gisReady = null, gisKlaar = null;
  function loadGis() {
    if (!gisReady) gisReady = new Promise((res, rej) => {
      const el = Object.assign(document.createElement('script'), { src: 'https://accounts.google.com/gsi/client', async: true });
      el.onload = () => {
        google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: resp => {
            const cred = firebase.auth.GoogleAuthProvider.credential(resp.credential);
            auth.signInWithCredential(cred).then(() => gisKlaar?.()).catch(authFout);
          },
          auto_select: false,
          cancel_on_tap_outside: true,
        });
        res();
      };
      el.onerror = () => { gisReady = null; rej(new Error('De inlogknop van Google kon niet worden geladen (adblocker of geen verbinding?)')); };
      document.head.appendChild(el);
    });
    return gisReady;
  }
  // Toont de Google-knop in el; onKlaar wordt aangeroepen zodra de inlog bij Firebase gelukt is.
  function renderGoogleButton(el, onKlaar) {
    gisKlaar = onKlaar;
    return loadGis().then(() => {
      el.innerHTML = '';
      google.accounts.id.renderButton(el, { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', locale: 'nl', width: 280 });
    });
  }

  // Oude manier (reserve): eerst een pop-upvenster; lukt dat niet (geblokkeerd of niet ondersteund), dan via doorsturen naar Google.
  function signInPopup() {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    auth.signInWithPopup(provider).catch(e => {
      if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
      if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
        return auth.signInWithRedirect(provider).catch(authFout);
      }
      authFout(e);
    });
  }

  function signOut() { try { google.accounts.id.disableAutoSelect(); } catch (e) { /* niet geladen */ } auth.signOut(); }

  // Wijzigingen even verzamelen en dan in één keer wegschrijven.
  function save(data) {
    pending = data;
    clearTimeout(timer);
    timer = setTimeout(flush, 400);
  }

  function flush() {
    if (!pending) return;
    const str = JSON.stringify(pending);
    pending = null;
    lastData = str;
    root.update({ data: str, updatedAt: firebase.database.ServerValue.TIMESTAMP }).then(() => handlers.onSaved?.()).catch(e => {
      console.warn('Opslaan online mislukt', e);
      handlers.onError(e);
    });
  }

  return {
    enabled, init, signInPopup, renderGoogleButton, signOut, save, flush, addAdmin, removeAdmin, emailKey, getMedia, setMedia,
    status: () => status,
    user: () => user,
    canEdit: () => editor,
    remoteEmpty: () => remoteEmpty,
    admins: () => admins,
    adminsError: () => adminsError,
    log,
    logEntries: () => logEntries,
    logError: () => logError,
  };
})();
