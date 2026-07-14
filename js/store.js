/* ============================================================
   Store — the data layer.

   Two modes, same interface:

   REMOTE  — Supabase is configured. Google Sign-In required. Accounts
             live in Postgres, photos in object storage, everyone on the
             team sees the same board.

   LOCAL   — Supabase is not configured. No sign-in. Everything stays in
             this browser. Photos are downscaled and stored inline.

   Writes are per-account and debounced, so a rep typing into a building
   record doesn't hammer the network, and two reps working different
   accounts never overwrite each other.
   ============================================================ */
(function () {
  const CFG = window.ARC_CONFIG || {};
  const REMOTE = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  const LKEY = 'teamallied_bd_v1';

  let sb = null;
  let user = null;

  /* ---------- local mode ---------- */
  const local = {
    read() {
      try { const r = localStorage.getItem(LKEY); return r ? JSON.parse(r) : null; }
      catch { return null; }
    },
    write(db) {
      try { localStorage.setItem(LKEY, JSON.stringify(db)); }
      catch (e) {
        console.warn('Local storage is full.', e);
        alert('This browser is out of storage — most likely too many photos.\n\nUse "Back up" to export your data, then connect Supabase so photos are stored properly.');
      }
    }
  };

  /* ---------- image handling ---------- */
  // Phone cameras produce 4–12MB files. Nobody needs that to find a valve.
  function downscale(file, maxPx, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        c.toBlob(b => b ? resolve(b) : reject(new Error('Could not process that image.')),
                 'image/jpeg', quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image we can read.')); };
      img.src = url;
    });
  }
  const toDataURL = blob => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error('Could not read that image.'));
    r.readAsDataURL(blob);
  });

  /* ---------- debounced per-account writes ---------- */
  const pending = new Map();
  function queue(id, fn, ms = 700) {
    clearTimeout(pending.get(id));
    pending.set(id, setTimeout(() => { pending.delete(id); fn(); }, ms));
  }
  function flush() {
    pending.forEach((t, id) => { clearTimeout(t); });
    pending.clear();
  }

  const Store = {
    mode: REMOTE ? 'remote' : 'local',
    isRemote: REMOTE,
    user: () => user,

    /* Boot. Returns {signedIn} — in local mode always true. */
    async init() {
      if (!REMOTE) return { signedIn: true };
      if (!window.supabase) throw new Error('The Supabase library did not load. Check your network.');
      sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
      const { data } = await sb.auth.getSession();
      user = data.session?.user || null;
      sb.auth.onAuthStateChange((_e, s) => { user = s?.user || null; });
      return { signedIn: !!user };
    },

    async signIn() {
      const { error } = await sb.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: CFG.REDIRECT }
      });
      if (error) throw error;
    },

    async signOut() {
      flush();
      if (sb) await sb.auth.signOut();
      user = null;
      location.reload();
    },

    /* Load everything the app needs. Shape matches the local DB exactly,
       so the rest of the app doesn't care which mode it's in. */
    async loadAll() {
      if (!REMOTE) return local.read();

      const [{ data: accts, error: e1 }, { data: weeks, error: e2 }] = await Promise.all([
        sb.from('accounts').select('id,payload').order('updated_at', { ascending: false }),
        sb.from('weeks').select('week,payload').eq('email', user.email)
      ]);

      // The single most likely error: signed in with Google, but the email
      // isn't in the members table. Say so plainly instead of showing an
      // empty board and letting them think the data is gone.
      if (e1 || e2) {
        const err = e1 || e2;
        if (err.code === 'PGRST301' || /permission|policy|row-level/i.test(err.message || '')) {
          const e = new Error(`${user.email} is signed in, but isn't on the members list. An admin needs to add it in Supabase → Table Editor → members.`);
          e.notMember = true;
          throw e;
        }
        throw err;
      }

      const W = {};
      (weeks || []).forEach(w => { W[w.week] = w.payload || {}; });
      return { accts: (accts || []).map(r => r.payload), weeks: W };
    },

    async saveAccount(a) {
      if (!REMOTE) return; // local mode writes the whole DB (see saveLocal)
      queue(a.id, async () => {
        const { error } = await sb.from('accounts').upsert({ id: a.id, payload: a });
        if (error) console.error('Could not save', a.name, error.message);
      });
    },

    /* Bulk insert. A 300-row target list as 300 separate requests would be
       rude to the API and slow for the user. One upsert, chunked. */
    async saveAccounts(list) {
      if (!REMOTE || !list.length) return;
      const CHUNK = 100;
      for (let i = 0; i < list.length; i += CHUNK) {
        const rows = list.slice(i, i + CHUNK).map(a => ({ id: a.id, payload: a }));
        const { error } = await sb.from('accounts').upsert(rows);
        if (error) throw new Error('Import failed partway through: ' + error.message);
      }
    },

    async deleteAccount(id) {
      if (!REMOTE) return;
      clearTimeout(pending.get(id)); pending.delete(id);
      const { error } = await sb.from('accounts').delete().eq('id', id);
      if (error) console.error('Could not delete', error.message);
    },

    async saveWeek(week, payload) {
      if (!REMOTE) return;
      queue('week:' + week, async () => {
        const { error } = await sb.from('weeks')
          .upsert({ email: user.email, week, payload });
        if (error) console.error('Could not save the week', error.message);
      }, 900);
    },

    // Local mode only: persist the whole document.
    saveLocal(db) { if (!REMOTE) local.write(db); },

    /* ---------- photos ---------- */

    /* Upload a photo of a shutoff (or anything else). Returns a record
       the app stores on the row. In remote mode that's a storage path; in
       local mode it's an inline data URL. */
    async uploadPhoto(file, meta = {}) {
      if (!file) throw new Error('No file selected.');
      if (!/^image\//.test(file.type)) throw new Error('That file is not an image.');

      if (!REMOTE) {
        const small = await downscale(file, 1000, 0.55);
        return { kind: 'inline', url: await toDataURL(small), at: new Date().toISOString() };
      }

      const blob = await downscale(file, 1600, 0.72);
      const safe = s => String(s || 'x').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40);
      const path = `${safe(meta.acct)}/${safe(meta.bldg)}/${safe(meta.label)}-${Date.now()}.jpg`;

      const { error } = await sb.storage.from('arp-photos')
        .upload(path, blob, { contentType: 'image/jpeg', upsert: false });
      if (error) throw new Error('Upload failed: ' + error.message);

      return { kind: 'path', path, at: new Date().toISOString(), by: user.email };
    },

    /* Photos are private. Turn a stored path into a viewable URL that
       expires in an hour. */
    async photoURL(p) {
      if (!p) return '';
      if (p.kind === 'inline') return p.url;
      if (!REMOTE) return '';
      const { data, error } = await sb.storage.from('arp-photos')
        .createSignedUrl(p.path, 3600);
      return error ? '' : data.signedUrl;
    },

    async deletePhoto(p) {
      if (!p || p.kind !== 'path' || !REMOTE) return;
      await sb.storage.from('arp-photos').remove([p.path]);
    },

    flush
  };

  window.Store = Store;
  window.addEventListener('beforeunload', flush);
})();/* ============================================================
   Store — the data layer.

   Two modes, same interface:

   REMOTE  — Supabase is configured. Google Sign-In required. Accounts
             live in Postgres, photos in object storage, everyone on the
             team sees the same board.

   LOCAL   — Supabase is not configured. No sign-in. Everything stays in
             this browser. Photos are downscaled and stored inline.

   Writes are per-account and debounced, so a rep typing into a building
   record doesn't hammer the network, and two reps working different
   accounts never overwrite each other.
   ============================================================ */
(function () {
  const CFG = window.ARC_CONFIG || {};
  const REMOTE = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  const LKEY = 'teamallied_bd_v1';

  let sb = null;
  let user = null;

  /* ---------- local mode ---------- */
  const local = {
    read() {
      try { const r = localStorage.getItem(LKEY); return r ? JSON.parse(r) : null; }
      catch { return null; }
    },
    write(db) {
      try { localStorage.setItem(LKEY, JSON.stringify(db)); }
      catch (e) {
        console.warn('Local storage is full.', e);
        alert('This browser is out of storage — most likely too many photos.\n\nUse "Back up" to export your data, then connect Supabase so photos are stored properly.');
      }
    }
  };

  /* ---------- image handling ---------- */
  // Phone cameras produce 4–12MB files. Nobody needs that to find a valve.
  function downscale(file, maxPx, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        c.toBlob(b => b ? resolve(b) : reject(new Error('Could not process that image.')),
                 'image/jpeg', quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image we can read.')); };
      img.src = url;
    });
  }
  const toDataURL = blob => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error('Could not read that image.'));
    r.readAsDataURL(blob);
  });

  /* ---------- debounced per-account writes ---------- */
  const pending = new Map();
  function queue(id, fn, ms = 700) {
    clearTimeout(pending.get(id));
    pending.set(id, setTimeout(() => { pending.delete(id); fn(); }, ms));
  }
  function flush() {
    pending.forEach((t, id) => { clearTimeout(t); });
    pending.clear();
  }

  const Store = {
    mode: REMOTE ? 'remote' : 'local',
    isRemote: REMOTE,
    user: () => user,

    /* Boot. Returns {signedIn} — in local mode always true. */
    async init() {
      if (!REMOTE) return { signedIn: true };
      if (!window.supabase) throw new Error('The Supabase library did not load. Check your network.');
      sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
      const { data } = await sb.auth.getSession();
      user = data.session?.user || null;
      sb.auth.onAuthStateChange((_e, s) => { user = s?.user || null; });
      return { signedIn: !!user };
    },

    async signIn() {
      const { error } = await sb.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: CFG.REDIRECT }
      });
      if (error) throw error;
    },

    async signOut() {
      flush();
      if (sb) await sb.auth.signOut();
      user = null;
      location.reload();
    },

    /* Load everything the app needs. Shape matches the local DB exactly,
       so the rest of the app doesn't care which mode it's in. */
    async loadAll() {
      if (!REMOTE) return local.read();

      const [{ data: accts, error: e1 }, { data: weeks, error: e2 }] = await Promise.all([
        sb.from('accounts').select('id,payload').order('updated_at', { ascending: false }),
        sb.from('weeks').select('week,payload').eq('email', user.email)
      ]);

      // The single most likely error: signed in with Google, but the email
      // isn't in the members table. Say so plainly instead of showing an
      // empty board and letting them think the data is gone.
      if (e1 || e2) {
        const err = e1 || e2;
        if (err.code === 'PGRST301' || /permission|policy|row-level/i.test(err.message || '')) {
          const e = new Error(`${user.email} is signed in, but isn't on the members list. An admin needs to add it in Supabase → Table Editor → members.`);
          e.notMember = true;
          throw e;
        }
        throw err;
      }

      const W = {};
      (weeks || []).forEach(w => { W[w.week] = w.payload || {}; });
      return { accts: (accts || []).map(r => r.payload), weeks: W };
    },

    async saveAccount(a) {
      if (!REMOTE) return; // local mode writes the whole DB (see saveLocal)
      queue(a.id, async () => {
        const { error } = await sb.from('accounts').upsert({ id: a.id, payload: a });
        if (error) console.error('Could not save', a.name, error.message);
      });
    },

    async deleteAccount(id) {
      if (!REMOTE) return;
      clearTimeout(pending.get(id)); pending.delete(id);
      const { error } = await sb.from('accounts').delete().eq('id', id);
      if (error) console.error('Could not delete', error.message);
    },

    async saveWeek(week, payload) {
      if (!REMOTE) return;
      queue('week:' + week, async () => {
        const { error } = await sb.from('weeks')
          .upsert({ email: user.email, week, payload });
        if (error) console.error('Could not save the week', error.message);
      }, 900);
    },

    // Local mode only: persist the whole document.
    saveLocal(db) { if (!REMOTE) local.write(db); },

    /* ---------- photos ---------- */

    /* Upload a photo of a shutoff (or anything else). Returns a record
       the app stores on the row. In remote mode that's a storage path; in
       local mode it's an inline data URL. */
    async uploadPhoto(file, meta = {}) {
      if (!file) throw new Error('No file selected.');
      if (!/^image\//.test(file.type)) throw new Error('That file is not an image.');

      if (!REMOTE) {
        const small = await downscale(file, 1000, 0.55);
        return { kind: 'inline', url: await toDataURL(small), at: new Date().toISOString() };
      }

      const blob = await downscale(file, 1600, 0.72);
      const safe = s => String(s || 'x').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40);
      const path = `${safe(meta.acct)}/${safe(meta.bldg)}/${safe(meta.label)}-${Date.now()}.jpg`;

      const { error } = await sb.storage.from('arp-photos')
        .upload(path, blob, { contentType: 'image/jpeg', upsert: false });
      if (error) throw new Error('Upload failed: ' + error.message);

      return { kind: 'path', path, at: new Date().toISOString(), by: user.email };
    },

    /* Photos are private. Turn a stored path into a viewable URL that
       expires in an hour. */
    async photoURL(p) {
      if (!p) return '';
      if (p.kind === 'inline') return p.url;
      if (!REMOTE) return '';
      const { data, error } = await sb.storage.from('arp-photos')
        .createSignedUrl(p.path, 3600);
      return error ? '' : data.signedUrl;
    },

    async deletePhoto(p) {
      if (!p || p.kind !== 'path' || !REMOTE) return;
      await sb.storage.from('arp-photos').remove([p.path]);
    },

    flush
  };

  window.Store = Store;
  window.addEventListener('beforeunload', flush);
})();
