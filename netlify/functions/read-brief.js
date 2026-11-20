// Emma — read_brief tool (2026-11-20)
// Gives Emma read-only access to Ray's two Monvoy briefs in Google Drive
// (r@monvoy.co), plus the Monvoy suppliers and Monvoy leathers docs (added 20 Nov). Used by emma-telegram-background.js. Needs the
// drive.readonly scope on GOOGLE_REFRESH_TOKEN.

const BRIEF_DOCS = {
  main: { id: '1RcGB9GSxDkkJ6nw-04ixzFVchHGNIajXFBJt95CXqXc', title: 'Monvoy Brief' },
  journal: { id: '17x3Vn_4XBNVhg2-AqBGT2oIXMLHCTHRmli7-NobKcTQ', title: 'Monvoy journal brief' },
  suppliers: { id: '19y0C4nuGrViqbE-wkYBLn4rvK-LFEuuT374ah2D8-wk', title: 'Monvoy suppliers' },
  leathers: { id: '1uatr-JYTEs4j9qVUyWB74KcDUuXDMLdLImzRwac-OoM', title: 'Monvoy leathers' },
};
const BRIEF_MAX_CHARS = 12000;

const READ_BRIEF_TOOL ={
    name: 'read_brief',
    description:
      "Read Ray's living Monvoy briefs (Google Docs, read-only) — the source of truth for the Monvoy brand, journal range, leathers, suppliers, pricing, packaging, charms and past decisions. Use it whenever Ray talks about Monvoy, journals, leather, suppliers or product ideas, so he never has to repeat what's already decided. brief: 'main' (Monvoy Brief: positioning, range, pricing, packaging, charms, decision log), 'journal' (journal construction and specification detail) 'suppliers' (every supplier with country, product, contact or website, status and notes — use this for any 'who supplies…' question) or 'leathers' (Buttero, Minerva Liscio and Box, Elbamatt: properties, thickness, temper ratings, where to buy, status). Call with no query to list the section headings; call with query keywords (e.g. 'elastic supplier', 'Buttero colours') to get just the matching sections. You cannot edit the briefs: record new ideas or supplier details with save_memory and tell Ray they're ready to go into the brief.",
    input_schema: {
      type: 'object',
      properties: {
        brief: { type: 'string', enum: ['main', 'journal', 'suppliers', 'leathers'], description: "Which brief to read. Defaults to 'main'." },
        query: { type: 'string', description: 'Keywords to find relevant sections. Omit to get the list of headings.' },
      },
    },
  };

// Reads one of Ray's Monvoy briefs from Google Drive (read-only). With no
// query it returns the section headings; with a query it returns only the
// sections that mention the keywords, capped at BRIEF_MAX_CHARS, so a brief
// lookup never pulls the whole document into the conversation.
async function readBrief({ brief = 'main', query = '' } = {}, getGoogleAccessToken) {
  const doc = BRIEF_DOCS[brief];
  if (!doc) return { error: `Unknown brief "${brief}". Use "main", "journal", "suppliers" or "leathers".` };
  const accessToken = await getGoogleAccessToken();
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${doc.id}/export?mimeType=text%2Fmarkdown`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    return { error: `Could not read ${doc.title} (${res.status}): ${(await res.text()).slice(0, 300)}` };
  }
  const md = await res.text();

  const sections = [];
  let current = { heading: '(top)', lines: [] };
  for (const line of md.split('\n')) {
    if (/^#{1,6}\s/.test(line)) {
      if (current.lines.length) sections.push(current);
      current = { heading: line.replace(/^#+\s*/, '').replace(/\*/g, '').trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length) sections.push(current);

  const terms = String(query || '').toLowerCase().split(/[\s,]+/).filter((w) => w.length > 2);
  if (!terms.length) {
    return {
      brief: doc.title,
      sections: sections.map((s) => s.heading),
      note: 'Call read_brief again with a query to read the matching sections.',
    };
  }

  const matches = sections.filter((s) => {
    const text = s.lines.join('\n').toLowerCase();
    return terms.some((w) => text.includes(w));
  });
  let content = '';
  const included = [];
  for (const s of matches) {
    const block = s.lines.join('\n').trim();
    if (content.length + block.length > BRIEF_MAX_CHARS) break;
    content += block + '\n\n';
    included.push(s.heading);
  }
  return {
    brief: doc.title,
    query,
    matched_sections: matches.map((s) => s.heading),
    included_sections: included,
    truncated: included.length < matches.length,
    content: content.trim() || 'No sections matched those keywords.',
  };
}

module.exports = { READ_BRIEF_TOOL, readBrief };
