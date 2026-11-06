// Online opslag van het congresprogramma via dezelfde Firebase Realtime Database als het padeltoernooi.
// Iedereen mag het programma lezen; alleen congresbeheerders (en de eigenaar uit de databaseregels)
// mogen het wijzigen. Zonder Firebase (file://, ?lokaal) werkt de site lokaal in deze browser.
//
// Opslag:
//   /congres/data        – het hele programma als JSON-tekst
//   /congres/updatedAt   – servertijd van de laatste wijziging
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

  const emailKey = email => String(email).trim().toLowerCase().replace(/\./g, ',');

  function init(h) {
    handlers = h;
    if (!enabled) return;
    firebase.initializeApp(firebaseConfig);
    auth = firebase.auth();
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
      stopLive();
      if (u) {
        try {
          await firebase.database().ref('congresLogin/' + emailKey(u.email)).set(firebase.database.ServerValue.TIMESTAMP);
          editor = true;
          watchLive();
          watchAdmins();
        } catch (e) {
          handlers.onDenied(u.email);
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

  function signIn() {
    auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(e => {
      if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
        alert('Inloggen mislukt: ' + e.message);
      }
    });
  }

  function signOut() { auth.signOut(); }

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
    enabled, init, signIn, signOut, save, flush, addAdmin, removeAdmin, emailKey,
    status: () => status,
    user: () => user,
    canEdit: () => editor,
    remoteEmpty: () => remoteEmpty,
    admins: () => admins,
    adminsError: () => adminsError,
  };
})();
