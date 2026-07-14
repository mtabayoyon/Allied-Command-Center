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

    /* ---------- jobs ---------- */

    async loadJobs() {
      if (!REMOTE) {
        try { const r = localStorage.getItem('teamallied_jobs'); return r ? JSON.parse(r) : []; }
        catch { return []; }
      }
      const { data, error } = await sb.from('jobs').select('payload').order('updated_at', {ascending:false});
      if (error) { console.error('Could not load jobs:', error.message); return []; }
      return (data || []).map(r => r.payload);
    },

    async saveJob(j) {
      if (!REMOTE) return;
      queue('job:' + j.id, async () => {
        const { error } = await sb.from('jobs')
          .upsert({ id: j.id, account_id: j.acctId, building_id: j.bldgId || null, payload: j });
        if (error) console.error('Could not save the job', error.message);
      });
    },

    async deleteJob(id) {
      if (!REMOTE) return;
      clearTimeout(pending.get('job:' + id)); pending.delete('job:' + id);
      const { error } = await sb.from('jobs').delete().eq('id', id);
      if (error) console.error('Could not delete the job:', error.message);
    },

    saveJobsLocal(list) {
      if (REMOTE) return;
      try { localStorage.setItem('teamallied_jobs', JSON.stringify(list)); } catch {}
    },

    /* ---------- documents ----------
       Invoices, Xactimate estimates, receipts, signed authorizations. Any
       file type, up to 25MB. Images get downscaled; everything else goes up
       as-is, because a compressed PDF invoice is a useless PDF invoice. */

    async uploadDoc(file, meta = {}) {
      if (!file) throw new Error('No file selected.');
      if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} is over 25MB. Compress it or split it.`);

      const isImg = /^image\//.test(file.type);

      if (!REMOTE) {
        if (!isImg) throw new Error('Storing documents needs the shared board. Connect Supabase first.');
        const small = await downscale(file, 1000, 0.55);
        return { kind:'inline', name:file.name, url: await toDataURL(small), at:new Date().toISOString() };
      }

      const body = isImg ? await downscale(file, 1900, 0.8) : file;
      const safe = s => String(s || 'x').replace(/[^a-z0-9.]+/gi,'-').toLowerCase().slice(0,60);
      const path = `${safe(meta.acct)}/${safe(meta.job || 'job')}/${Date.now()}-${safe(file.name)}`;

      const { error } = await sb.storage.from('job-docs')
        .upload(path, body, { contentType: isImg ? 'image/jpeg' : (file.type || 'application/octet-stream') });
      if (error) throw new Error('Upload failed: ' + error.message);

      return {
        kind: 'doc', path, name: file.name,
        mime: isImg ? 'image/jpeg' : (file.type || ''),
        size: body.size || file.size,
        img: isImg,
        at: new Date().toISOString(), by: user.email
      };
    },

    async docURL(d) {
      if (!d) return '';
      if (d.kind === 'inline') return d.url;
      if (!REMOTE || !d.path) return '';
      const { data, error } = await sb.storage.from('job-docs').createSignedUrl(d.path, 3600);
      return error ? '' : data.signedUrl;
    },

    async deleteDoc(d) {
      if (!d || d.kind !== 'doc' || !REMOTE) return;
      await sb.storage.from('job-docs').remove([d.path]);
    },

    /* ---------- vendor directory ---------- */
    /* One record per vendor company. Buildings link to them by id. */

    async loadVendors() {
      if (!REMOTE) {
        try { const r = localStorage.getItem('teamallied_vendors'); return r ? JSON.parse(r) : []; }
        catch { return []; }
      }
      const { data, error } = await sb.from('vendors').select('payload').order('updated_at', {ascending:false});
      if (error) { console.error('Could not load vendors:', error.message); return []; }
      return (data || []).map(r => r.payload);
    },

    async saveVendor(v) {
      if (!REMOTE) return;
      queue('vendor:' + v.id, async () => {
        const { error } = await sb.from('vendors').upsert({ id: v.id, payload: v });
        if (error) console.error('Could not save vendor', v.name, error.message);
      });
    },

    async saveVendors(list) {
      if (!REMOTE || !list.length) return;
      const rows = list.map(v => ({ id: v.id, payload: v }));
      const { error } = await sb.from('vendors').upsert(rows);
      if (error) throw new Error('Could not save the vendors: ' + error.message);
    },

    async deleteVendor(id) {
      if (!REMOTE) return;
      clearTimeout(pending.get('vendor:' + id)); pending.delete('vendor:' + id);
      const { error } = await sb.from('vendors').delete().eq('id', id);
      if (error) console.error('Could not delete vendor:', error.message);
    },

    saveVendorsLocal(list) {
      if (REMOTE) return;
      try { localStorage.setItem('teamallied_vendors', JSON.stringify(list)); } catch {}
    },

    /* ---------- client portal ---------- */

    /* Create a link we can send a property manager. The token is long and
       random (it's the actual lock); the code is short enough to say over
       the phone. Both are needed to open the page. */
    async createShare(acct, bldg, days = 30) {
      if (!REMOTE) throw new Error('Client links need the shared board. Connect Supabase first.');
      const rnd = n => {
        const a = new Uint8Array(n); crypto.getRandomValues(a);
        return Array.from(a, b => b.toString(36).padStart(2,'0')).join('').slice(0,n);
      };
      // no 0/O/1/I — these get read aloud and written down
      const ALPHA = 'ACDEFGHJKLMNPQRTUVWXY34679';
      const code = Array.from(crypto.getRandomValues(new Uint8Array(6)))
                        .map(b => ALPHA[b % ALPHA.length]).join('');
      const token = rnd(32);

      const { error } = await sb.from('shares').insert({
        token, code,
        account_id: acct.id,
        building_id: bldg.id,
        label: bldg.name || 'Building profile',
        created_by: user.email,
        expires_at: days ? new Date(Date.now() + days*864e5).toISOString() : null
      });
      if (error) throw new Error('Could not create the link: ' + error.message);

      const base = location.origin + location.pathname.replace(/[^/]*$/, '');
      return { token, code, url: `${base}building.html?t=${token}` };
    },

    async listShares(buildingId) {
      if (!REMOTE) return [];
      const { data, error } = await sb.from('shares')
        .select('*').eq('building_id', buildingId).order('created_at', {ascending:false});
      if (error) return [];
      return data || [];
    },

    async revokeShare(token) {
      if (!REMOTE) return;
      await sb.from('shares').update({ revoked: true }).eq('token', token);
    },

    /* What clients have sent back and we haven't looked at yet. */
    async pendingSubmissions() {
      if (!REMOTE) return [];
      const { data, error } = await sb.from('submissions')
        .select('*').eq('status','pending').order('created_at', {ascending:false});
      if (error) { console.error(error.message); return []; }
      return data || [];
    },

    async reviewSubmission(id, status) {
      if (!REMOTE) return;
      const { error } = await sb.from('submissions')
        .update({ status, reviewed_by: user.email, reviewed_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw new Error(error.message);
    },

    /* Move a client's photo out of the write-only client bucket and into
       the real one, so it prints on the plan like any other. */
    async adoptPhoto(p) {
      if (!REMOTE || !p || p.kind !== 'client') return p;
      const { data, error } = await sb.storage.from('client-uploads').download(p.path);
      if (error) return p;                       // leave it; better than losing the record
      const path = `client/${Date.now()}-${p.path}`;
      const up = await sb.storage.from('arp-photos').upload(path, data, {contentType:'image/jpeg'});
      if (up.error) return p;
      await sb.storage.from('client-uploads').remove([p.path]);
      return { kind:'path', path, at:p.at, by:'client' };
    },

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
