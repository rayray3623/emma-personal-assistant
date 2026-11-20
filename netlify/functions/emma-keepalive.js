// Emma — Supabase keep-alive (2026-11-20)
// Supabase pauses free projects after 7 days without enough activity, and
// it warned that Emma's project (nqgylubfhztxfgpbmvnm) was due to be paused.
// This runs once a day (schedule in netlify.toml) and makes one tiny read,
// so the project always counts as active, whatever else Emma is doing.

exports.handler = async function () {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Keep-alive: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return { statusCode: 500, body: 'Missing config' };
  }

  try {
    const res = await fetch(`${url}/rest/v1/emma_tasks?select=id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    console.log('Keep-alive:', res.status, new Date().toISOString());
    return { statusCode: 200, body: `ok ${res.status}` };
  } catch (err) {
    console.error('Keep-alive failed:', err);
    return { statusCode: 500, body: 'Keep-alive failed' };
  }
};
