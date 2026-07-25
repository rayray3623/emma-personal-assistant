// netlify/functions/emma-notify.js
//
// Scheduled function (see netlify.toml) — runs hourly, checking calendar,
// inbox, and task deadlines each time, and judges whether anything is
// worth proactively telling Ray about, unprompted, over WhatsApp (email is
// unconditional, see EMAIL POLICY below; calendar/tasks still go through
// judgment). This is a deliberate exception to Emma's normal reactive-only
// behaviour, per Ray's explicit decision — first made 7 July 2026 (stub/
// logging only at that point, WhatsApp wasn't live), reaffirmed and
// extended to genuine proactive sending 14 July 2026 once Emma's WhatsApp
// number was verified. Schedule moved from 3x/day to hourly 14 July 2026,
// also per Ray's explicit instruction — the gap between a message arriving
// and Emma noticing was originally up to ~5 hours, which isn't really
// "alerting". Hourly caps the worst case at under an hour instead. True
// real-time (Gmail push via Cloud Pub/Sub) was considered and explicitly
// deferred — meaningfully more infrastructure (Pub/Sub topic, domain
// verification, a subscription needing renewal every 7 days) for marginal
// benefit over hourly for a personal inbox.
//
// EMAIL POLICY (updated 14 July 2026): every new unread email now notifies
// Ray unconditionally — no judgment call applied. Ray is actively pruning
// this inbox down to essential senders (unsubscribing from newsletters
// etc.), so "every email" and "every email worth seeing" are converging by
// design; some transitional noise from remaining newsletters is expected
// and accepted. Calendar events and task deadlines still go through
// Emma's judgment call as before — this change is deliberately scoped to
// email only.
//
// Env vars: same as chat.js/whatsapp-background.js — GOOGLE_CLIENT_ID/
// SECRET/REFRESH_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// ANTHROPIC_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
// TWILIO_WHATSAPP_NUMBER, EMMA_OWNER_WHATSAPP_NUMBER

async function supabaseRequest(path, options = {}) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase error (${res.status}): ${await res.text()}`);
  // Requests using Prefer: return=minimal (e.g. saving a conversation turn,
  // logging a notification) get back a genuinely empty 201/204 body —
  // calling res.json() directly on that throws "Unexpected end of JSON
  // input". Read as text first and only parse if there's actually content.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getGoogleAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Google token refresh failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function fetchUpcomingEvents(accessToken) {
  // A 6-hour look-ahead window comfortably overlaps between checks spaced
  // ~5 hours apart (07:00/12:00/17:00 UTC), so nothing falls in a gap.
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&maxResults=15&singleEvents=true&orderBy=startTime`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) throw new Error('Calendar list failed: ' + JSON.stringify(data));
  return (data.items || []).map((e) => ({
    id: e.id,
    summary: e.summary || '(no title)',
    start: e.start?.dateTime || e.start?.date,
    location: e.location || null,
  }));
}

async function fetchRecentUnreadEmails(accessToken) {
  // Same 6-hour window as calendar, for the same overlap reasoning.
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent('is:unread newer_than:1d')}&maxResults=15`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const listData = await listRes.json();
  if (!listRes.ok) throw new Error('Gmail list failed: ' + JSON.stringify(listData));
  const messages = listData.messages || [];
  if (!messages.length) return [];

  return Promise.all(
    messages.map(async (m) => {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const msgData = await msgRes.json();
      const headers = msgData.payload?.headers || [];
      const get = (name) => headers.find((h) => h.name === name)?.value || '';
      return { id: m.id, from: get('From'), subject: get('Subject'), date: get('Date'), snippet: msgData.snippet || '' };
    })
  );
}

async function fetchUpcomingTaskDeadlines() {
  // Same 6-hour look-ahead as calendar/email, for the same overlap
  // reasoning between checks spaced ~5 hours apart.
  const windowEnd = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const rows = await supabaseRequest(
    `emma_tasks?status=neq.done&due_date=not.is.null&due_date=lte.${windowEnd}&order=due_date.asc`
  );
  return rows.map((t) => ({ id: String(t.id), task: t.task, due_date: t.due_date }));
}

function londonDateToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
}

function londonHourNow() {
  return parseInt(
    new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }),
    10
  );
}

// Standing check-ins (see whatsapp-background.js STANDING CHECK-INS) get
// nudged on a fixed daily schedule — noon, then 4pm if still nothing —
// deliberately UNCONDITIONAL like the email policy, not judge-gated like
// calendar/task deadlines. This is a standing instruction Ray gave once,
// not a per-item judgment call, so the "is this worth interrupting him
// for" bar doesn't apply here — same reasoning as why every email notifies
// regardless of the judge.
async function fetchCheckinNudges() {
  const hour = londonHourNow();
  if (hour < 12) return [];

  const today = londonDateToday();
  const checkins = await supabaseRequest('emma_checkins?status=eq.active&order=created_at.asc');
  if (!checkins.length) return [];

  const nudges = [];
  for (const c of checkins) {
    const todayRows = await supabaseRequest(`emma_checkin_progress?checkin_id=eq.${c.id}&date=eq.${today}`);
    if (todayRows.length) continue; // already reported today — nothing to nudge about

    // reference_id encodes checkin + date + window so the existing 24h
    // dedup (below) naturally sends at most one nudge per window per day,
    // and a fresh cycle starts automatically the next calendar date.
    nudges.push({
      reference_id: `checkin-${c.id}-${today}-noon`,
      trigger_type: 'checkin',
      message: `Nudge: no progress reported yet today on "${c.title}" — how's it going?`,
    });
    if (hour >= 16) {
      nudges.push({
        reference_id: `checkin-${c.id}-${today}-afternoon`,
        trigger_type: 'checkin',
        message: `Second nudge: still nothing logged today on "${c.title}" — where are things?`,
      });
    }
  }
  return nudges;
}

function isQuietHours() {
  const londonHour = parseInt(
    new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }),
    10
  );
  // 23:00–07:00 London time — respects normal sleeping hours, per Ray's
  // explicit instruction. This is a safety net independent of the cron
  // schedule itself, in case the schedule is ever misconfigured or this
  // function is triggered manually.
  return londonHour >= 23 || londonHour < 7;
}

async function sendWhatsAppMessage(toNumber, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_WHATSAPP_NUMBER;

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      From: `whatsapp:${fromNumber}`,
      To: `whatsapp:${toNumber}`,
      Body: body,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Twilio send failed: ' + JSON.stringify(data));
  return data;
}

exports.handler = async function () {
  if (isQuietHours()) {
    return { statusCode: 200, body: 'Quiet hours — skipped.' };
  }

  try {
    const accessToken = await getGoogleAccessToken();
    const [events, emails, taskDeadlines, checkinNudges] = await Promise.all([
      fetchUpcomingEvents(accessToken),
      fetchRecentUnreadEmails(accessToken),
      fetchUpcomingTaskDeadlines(),
      fetchCheckinNudges(),
    ]);

    if (!events.length && !emails.length && !taskDeadlines.length && !checkinNudges.length) {
      console.log('Gathered: 0 events, 0 emails, 0 task deadlines, 0 check-in nudges. Nothing to consider.');
      return { statusCode: 200, body: 'Nothing to consider.' };
    }

    console.log(`Gathered: ${events.length} events, ${emails.length} emails, ${taskDeadlines.length} task deadlines, ${checkinNudges.length} check-in nudges.`);
    if (emails.length) console.log('Emails found:', JSON.stringify(emails.map((e) => ({ id: e.id, from: e.from, subject: e.subject }))));

    // Dedup: don't re-flag anything already logged in the last 24 hours.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const alreadyLogged = await supabaseRequest(
      `emma_proactive_notifications?created_at=gte.${since}&select=reference_id`
    );
    const alreadyLoggedIds = new Set(alreadyLogged.map((r) => r.reference_id));

    const newEvents = events.filter((e) => !alreadyLoggedIds.has(e.id));
    const newEmails = emails.filter((e) => !alreadyLoggedIds.has(e.id));
    const newDeadlines = taskDeadlines.filter((t) => !alreadyLoggedIds.has(t.id));
    const newCheckinNudges = checkinNudges.filter((n) => !alreadyLoggedIds.has(n.reference_id));

    if (!newEvents.length && !newEmails.length && !newDeadlines.length && !newCheckinNudges.length) {
      console.log(`After dedup: 0 new events, 0 new emails, 0 new deadlines, 0 new check-in nudges (${alreadyLoggedIds.size} already logged in last 24h). Nothing new since last check.`);
      return { statusCode: 200, body: 'Nothing new since last check.' };
    }

    console.log(`After dedup: ${newEvents.length} new events, ${newEmails.length} new emails, ${newDeadlines.length} new deadlines, ${newCheckinNudges.length} new check-in nudges.`);

    // EMAIL POLICY (changed 14 July 2026, Ray's explicit instruction): every
    // new unread email notifies, full stop — no judgment call. Ray is
    // actively unsubscribing from newsletters/non-essential senders in this
    // inbox specifically so that "every email" and "every email worth
    // seeing" converge; until that cleanup is done there may be some noise
    // from remaining newsletters, which is expected and accepted as the
    // trade-off. Calendar events and task deadlines still go through
    // Emma's judgment below — this policy change is deliberately scoped to
    // email only.
    const emailDecisions = newEmails.map((e) => {
      const fromName = e.from.split('<')[0].trim() || e.from;
      return {
        reference_id: e.id,
        trigger_type: 'email',
        message: `New email — ${fromName}: "${e.subject}"`,
      };
    });

    let judgeDecisions = [];
    if (newEvents.length || newDeadlines.length) {
      const judgePrompt = `You are Emma, Ray Watte's personal AI assistant — dry, understated, warm, never sycophantic. You are deciding whether anything below is worth proactively messaging Ray about right now, unprompted, over WhatsApp. This is a deliberate exception to your normal reactive-only rule, so hold a genuinely high bar: a meeting he obviously already knows about is NOT worth it. A meeting starting soon that he might not have front-of-mind, or a task deadline that's arriving without him having acted on it, IS worth it. A message sent for something trivial costs more than it earns — when in doubt, don't send. (Note: email is handled separately and is not your concern here — every new email notifies unconditionally regardless of your judgment.)

Upcoming calendar events (next 6 hours):
${newEvents.length ? newEvents.map((e) => `- [id:${e.id}] "${e.summary}" at ${e.start}${e.location ? ' — ' + e.location : ''}`).join('\n') : '(none)'}

Task deadlines arriving within 6 hours:
${newDeadlines.length ? newDeadlines.map((t) => `- [id:${t.id}] "${t.task}" due ${t.due_date}`).join('\n') : '(none)'}

Respond with ONLY a JSON object — no markdown code fences, no \`\`\`json, no explanatory text before or after — in this exact shape:
{"send": [{"reference_id": "...", "trigger_type": "calendar"|"task", "message": "short WhatsApp-length message in your voice, as you'd actually text Ray"}], "skipped": [{"reference_id": "...", "reason": "brief reason you didn't flag this"}]}
Every item above must appear in exactly one of "send" or "skipped" — nothing should be silently omitted. If nothing is worth sending, "send" should be an empty array.`;

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 800,
          messages: [{ role: 'user', content: judgePrompt }],
        }),
      });
      const claudeData = await claudeRes.json();
      if (!claudeRes.ok) throw new Error('Anthropic API error: ' + JSON.stringify(claudeData));

      const rawText = claudeData.content?.[0]?.text || '{"send":[],"skipped":[]}';
      console.log('Judge raw response:', rawText);
      let parsed;
      try {
        const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
        parsed = JSON.parse(cleaned);
      } catch {
        console.error('Failed to parse judge response as JSON:', rawText);
        parsed = { send: [], skipped: [] };
      }
      judgeDecisions = Array.isArray(parsed.send) ? parsed.send : [];
      const skipped = Array.isArray(parsed.skipped) ? parsed.skipped : [];
      if (skipped.length) console.log('Skipped (with reasons):', JSON.stringify(skipped));
    }

    const decisions = [...emailDecisions, ...judgeDecisions, ...newCheckinNudges];
    if (emailDecisions.length) console.log(`${emailDecisions.length} email(s) auto-queued for send (no judgment applied, per policy).`);
    if (newCheckinNudges.length) console.log(`${newCheckinNudges.length} check-in nudge(s) auto-queued for send (no judgment applied, standing instruction).`);

    const ownerNumber = process.env.EMMA_OWNER_WHATSAPP_NUMBER;
    let sentCount = 0;

    for (const item of decisions) {
      if (!item.reference_id || !item.message) continue;
      await supabaseRequest('emma_proactive_notifications', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          trigger_type: item.trigger_type || 'unknown',
          reference_id: item.reference_id,
          message: item.message,
        }),
      });
      // Logging happens unconditionally above regardless of send success —
      // dedup and chat.js's fetchPendingProactiveNotes fallback both rely
      // on the row existing even if the WhatsApp send itself fails.
      try {
        if (ownerNumber) {
          await sendWhatsAppMessage(ownerNumber, item.message);
          sentCount++;
        } else {
          console.error('EMMA_OWNER_WHATSAPP_NUMBER not configured — logged only, not sent.');
        }
      } catch (err) {
        console.error(`Failed to send WhatsApp for ${item.reference_id}:`, err.message);
      }
    }

    return { statusCode: 200, body: `Logged ${decisions.length} notification(s), sent ${sentCount} via WhatsApp.` };
  } catch (err) {
    console.error('emma-notify error:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
