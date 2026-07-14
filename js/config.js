/* ============================================================
   Team Allied — BD Command Center
   Configuration. This is the only file most people need to edit.
   ============================================================

   These two values are safe to commit. The anon key is a *public*
   key — it identifies the project, it does not grant access. Access
   is decided by row-level security in Postgres and the members
   allowlist. Do NOT ever put the service_role key in here.

   Leave SUPABASE_URL empty to run the app in standalone mode: no
   sign-in, data stays in this browser only. Useful for testing.
   ============================================================ */

window.ARC_CONFIG = {

  // Supabase → Project Settings → API
  SUPABASE_URL: '',            // e.g. 'https://abcdefgh.supabase.co'
  SUPABASE_ANON_KEY: '',       // the long "anon / public" key

  // Cosmetic only — appears in the header.
  ORG: 'Team Allied',

  // Where Google should send people back after they sign in.
  // Leave as-is; it uses whatever URL the app is currently served from.
  REDIRECT: window.location.origin + window.location.pathname,
};
