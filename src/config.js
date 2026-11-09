// The ONLY lines to edit when connecting the app to a Supabase project (Supabase > Project Settings > API).
// If SB_URL still starts with "YOUR-", the app runs alone on the phone (no login, no sync).
export const SB_URL = 'https://xdjfiiuqiecntyuarvkq.supabase.co';
export const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhkamZpaXVxaWVjbnR5dWFydmtxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3NDM2NDcsImV4cCI6MjEwNjMxOTY0N30.kyiKWvh8OvQQG7vVtLHddc-Sksk_2U3ZVI42o3V51as';

// SAFE ROAD (fix for "Failed to fetch"): on Netlify the app talks to Supabase through its OWN address
// (https://your-site.netlify.app/sb/...). Netlify passes the call on to SB_URL (see the [[redirects]] rule in netlify.toml).
// So a phone network that cannot reach *.supabase.co (DNS/ISP block, CORS trouble) still works.
// If you change SB_URL above, change the "to =" address in netlify.toml too — they must match.
// Set to '' to switch the safe road off (the app then calls SB_URL directly, like before).
export const SB_PROXY = '/sb';
