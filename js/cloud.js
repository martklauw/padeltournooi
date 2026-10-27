// Online synchronisatie via Firebase Realtime Database.
// Iedereen mag meekijken; alleen organisatoren die volgens de databaseregels mogen schrijven
// kunnen het toernooi wijzigen. Zonder Firebase (offline, file://, ?lokaal) werkt de app lokaal.
//
// Opslag onder /tournament:
//   data    – het hele toernooi als JSON-tekst (Firebase bewaart geen null-waarden of lege lijsten)
//   rev     – versie-id van de laatste data-schrijfactie, om de eigen echo te herkennen
//   scores  – per wedstrijd-id {a, b}; leidend boven de scores in data, zodat meerdere
//             organisatoren tegelijk uitslagen kunnen invoeren
//   lastLogin – wordt geschreven bij inloggen om te testen of iemand schrijfrechten heeft
//
// Beheerders staan onder /admins/{e-mail met punten als komma's} = {email, addedBy, at}.
// Alleen beheerders (en de eigenaar uit de databaseregels) kunnen die lijst lezen en wijzigen.
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

  let root = null;
  let auth = null;
  let user = null;
  let editor = false;
  let status = enabled ? 'connecting' : 'local';
  let lastRev = null;
  let pending = null;
  let timer = null;
  let remoteEmpty = false;
  let handlers = {};
  let adminsRef = null;
  let admins = null;
  let adminsError = null;

  const emailKey = email => String(email).trim().toLowerCase().replace(/\./g, ',');

  const newRev = () => Math.random().toString(36).slice(2, 12);

  function init(h) {
    handlers = h;
    if (!enabled) return;
    firebase.initializeApp(firebaseConfig);
    auth = firebase.auth();
    root = firebase.database().ref('tournament');

    root.on('value', snap => {
      status = 'live';
      const v = snap.val() || {};
      let data = null;
      try { data = v.data ? JSON.parse(v.data) : null; } catch (e) { console.warn('Online toernooi onleesbaar', e); }
      remoteEmpty = !data;
      // Eigen echo of nog niet weggeschreven wijzigingen: alleen scores overnemen.
      const own = (v.rev && v.rev === lastRev) || !!pending;
      handlers.onData({ data, scores: v.scores || {}, own });
    }, err => {
      status = 'error';
      console.warn('Online toernooi niet leesbaar:', err.message);
      handlers.onStatus();
    });

    auth.onAuthStateChanged(async u => {
      user = u;
      editor = false;
      stopAdmins();
      if (u) {
        try {
          await root.child('lastLogin').set({ email: u.email, at: firebase.database.ServerValue.TIMESTAMP });
          editor = true;
          watchAdmins();
        } catch (e) {
          handlers.onDenied(u.email);
        }
      }
      handlers.onAuth();
    });
  }

  function watchAdmins() {
    adminsRef = firebase.database().ref('admins');
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
    adminsRef = null;
    admins = null;
    adminsError = null;
  }

  function addAdmin(email) {
    email = String(email).trim().toLowerCase();
    return firebase.database().ref('admins/' + emailKey(email)).set({
      email, addedBy: user?.email || null, at: firebase.database.ServerValue.TIMESTAMP,
    });
  }

  function removeAdmin(key) {
    return firebase.database().ref('admins/' + key).remove();
  }

  function signIn() {
    auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(e => {
      if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
        alert('Inloggen mislukt: ' + e.message);
      }
    });
  }

  function signOut() {
    auth.signOut();
  }

  function report(e) {
    console.warn('Opslaan online mislukt', e);
    handlers.onError(e);
  }

  // Wijzigingen in instellingen/schema worden even verzameld en dan in één keer weggeschreven.
  function saveData(state) {
    pending = state;
    clearTimeout(timer);
    timer = setTimeout(flush, 400);
  }

  function flush() {
    if (!pending) return;
    lastRev = newRev();
    const data = JSON.stringify(pending);
    pending = null;
    root.update({ data, rev: lastRev, updatedAt: firebase.database.ServerValue.TIMESTAMP }).catch(report);
  }

  // Hele toernooi vervangen, inclusief alle scores (nieuw schema, import, reset).
  function replaceAll(state) {
    clearTimeout(timer);
    pending = null;
    lastRev = newRev();
    root.update({
      data: JSON.stringify(state),
      rev: lastRev,
      updatedAt: firebase.database.ServerValue.TIMESTAMP,
      scores: scoresOf(state),
    }).catch(report);
  }

  function saveScore(id, a, b) {
    const ref = root.child('scores/' + id);
    (a == null && b == null ? ref.remove() : ref.set({ a: a ?? null, b: b ?? null })).catch(report);
  }

  function allMatches(state) {
    return [
      ...(state.schedule?.rounds || []).flatMap(r => r.matches),
      ...(state.knockout?.brackets || []).flatMap(b => b.rounds.flatMap(r => r.matches)),
    ];
  }

  function scoresOf(state) {
    const out = {};
    allMatches(state).forEach(m => {
      if (m.scoreA != null || m.scoreB != null) out[m.id] = { a: m.scoreA ?? null, b: m.scoreB ?? null };
    });
    return out;
  }

  function applyScores(state, scores) {
    allMatches(state).forEach(m => {
      const sc = scores[m.id];
      m.scoreA = sc && Number.isFinite(sc.a) ? sc.a : null;
      m.scoreB = sc && Number.isFinite(sc.b) ? sc.b : null;
    });
  }

  return {
    enabled,
    init,
    signIn,
    signOut,
    saveData,
    replaceAll,
    saveScore,
    applyScores,
    status: () => status,
    user: () => user,
    canEdit: () => editor,
    remoteEmpty: () => remoteEmpty,
    admins: () => admins,
    adminsError: () => adminsError,
    addAdmin,
    removeAdmin,
    emailKey,
  };
})();
