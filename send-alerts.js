/**
 * FIXTUREIQ ALERTS JOB
 *
 * Runs every few minutes on GitHub Actions. Checks the Premier League scores
 * (official FPL data) and sends push notifications for kick-off, goals and
 * full-time to every phone that has that match as a favourite or has a
 * prediction on it, even when FixtureIQ is closed.
 *
 * Needs one secret: FIREBASE_SERVICE_ACCOUNT (the Firebase admin key, JSON).
 * Uses only Node 20+ built-ins (fetch, crypto); no npm install needed.
 *
 * Local test without sending anything:  DRY_RUN=1 node send-alerts.js
 */
const crypto = require('crypto');
const fs = require('fs');

const DRY_RUN = process.env.DRY_RUN === '1';
const PROJECT_ID = 'fixtureiq';
const DB = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const STATE_DOC = 'alertState/current';
const LOCAL_STATE_FILE = __dirname + '/.state.json'; // dry runs only

// ==================== GOOGLE SIGN-IN (service account) ====================
async function getAccessToken() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${unsigned}.${signature}`,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google sign-in failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

// ==================== FIRESTORE ====================
function fromValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fromValue(x)]));
  return null;
}

async function db(token, method, path, body) {
  const res = await fetch(`${DB}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Firestore ${method} ${path} failed: ${JSON.stringify(data)}`);
  return data;
}

async function loadPhones(token) {
  const phones = [];
  let pageToken = '';
  do {
    const data = await db(token, 'GET', `pushTokens?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`);
    for (const d of data?.documents || []) {
      const f = Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, fromValue(v)]));
      if (f.token && f.liveAlerts !== false) phones.push({ uid: d.name.split('/').pop(), ...f });
    }
    pageToken = data?.nextPageToken || '';
  } while (pageToken);
  return phones;
}

async function loadState(token) {
  if (DRY_RUN) return fs.existsSync(LOCAL_STATE_FILE) ? JSON.parse(fs.readFileSync(LOCAL_STATE_FILE, 'utf8')) : null;
  const doc = await db(token, 'GET', STATE_DOC);
  return doc ? JSON.parse(fromValue(doc.fields.json) || 'null') : null;
}

async function saveState(token, state) {
  if (DRY_RUN) return fs.writeFileSync(LOCAL_STATE_FILE, JSON.stringify(state));
  await db(token, 'PATCH', STATE_DOC, { fields: { json: { stringValue: JSON.stringify(state) } } });
}

// ==================== FPL DATA ====================
async function loadFpl() {
  const [boot, fixtures] = await Promise.all([
    fetch('https://fantasy.premierleague.com/api/bootstrap-static/').then((r) => r.json()),
    fetch('https://fantasy.premierleague.com/api/fixtures/').then((r) => r.json()),
  ]);
  const teams = Object.fromEntries(boot.teams.map((t) => [t.id, t.name]));
  const players = Object.fromEntries(boot.elements.map((p) => [p.id, p.web_name]));
  return { teams, players, fixtures };
}

// Goal scorers so far: { elementId: goals } for each side (own goals count for the other side)
function scorers(f) {
  const out = { h: {}, a: {} };
  const add = (side, el, n) => { out[side][el] = (out[side][el] || 0) + n; };
  for (const s of f.stats || []) {
    if (s.identifier === 'goals_scored') {
      s.h.forEach((x) => add('h', x.element, x.value));
      s.a.forEach((x) => add('a', x.element, x.value));
    }
    if (s.identifier === 'own_goals') {
      s.h.forEach((x) => add('a', `og${x.element}`, x.value));
      s.a.forEach((x) => add('h', `og${x.element}`, x.value));
    }
  }
  return out;
}

// What changed in one fixture since the last run -> list of alerts
function eventsFor(f, before, teams, players) {
  const home = teams[f.team_h];
  const away = teams[f.team_a];
  const h = f.team_h_score ?? 0;
  const a = f.team_a_score ?? 0;
  const score = `${home} ${h}-${a} ${away}`;
  const events = [];
  const name = (el) => String(el).startsWith('og') ? `${players[String(el).slice(2)] || 'Unknown'} (own goal)` : (players[el] || null);

  if (f.started && !before.started) {
    events.push({ key: 'ko', title: 'Kick-off', body: `${home} v ${away} is underway.` });
  }

  if (f.started) {
    const now = scorers(f);
    for (const [side, team, count, prev] of [['h', home, h, before.h ?? 0], ['a', away, a, before.a ?? 0]]) {
      if (count > prev) {
        // Name the new scorer(s) when FPL has them already
        const newNames = [];
        for (const [el, n] of Object.entries(now[side])) {
          const was = before.scorers?.[side]?.[el] || 0;
          for (let i = was; i < n; i++) { const nm = name(el); if (nm) newNames.push(nm); }
        }
        const goals = count - prev;
        events.push({
          key: `g${side}${count}`,
          title: goals > 1 ? `${goals} goals for ${team}` : `Goal for ${team}`,
          body: `${score}${newNames.length ? ` (${newNames.join(', ')})` : ''}`,
        });
      }
    }
  }

  // FPL marks a game finished_provisional at the whistle, finished once confirmed
  const ended = f.finished_provisional || f.finished;
  if (ended && !before.ended) {
    events.push({ key: 'ft', title: 'Full-time', body: `${score}. Open FixtureIQ to see how your prediction did.` });
  }
  return events;
}

// ==================== EXPO PUSH ====================
async function sendPush(messages) {
  const results = [];
  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(batch),
    });
    const data = await res.json();
    (data.data || []).forEach((r, j) => results.push({ ...r, to: batch[j].to }));
  }
  return results;
}

// ==================== MAIN ====================
(async () => {
  const token = DRY_RUN ? null : await getAccessToken();
  const [{ teams, players, fixtures }, state, phones] = await Promise.all([
    loadFpl(),
    loadState(token),
    DRY_RUN ? Promise.resolve([]) : loadPhones(token),
  ]);

  // Only fixtures from the last day or the next few hours matter
  const nowMs = Date.now();
  const pastHours = Number(process.env.PAST_HOURS || 36); // override for testing
  const relevant = fixtures.filter((f) => {
    const t = new Date(f.kickoff_time || 0).getTime();
    return t && t > nowMs - pastHours * 3600e3 && t < nowMs + 6 * 3600e3;
  });

  const newState = { fixtures: {} };
  const alerts = []; // { fixtureId, title, body }
  for (const f of relevant) {
    const snap = {
      started: !!f.started,
      ended: !!(f.finished_provisional || f.finished),
      h: f.team_h_score ?? 0,
      a: f.team_a_score ?? 0,
      scorers: scorers(f),
    };
    newState.fixtures[f.id] = snap;
    const before = state?.fixtures?.[f.id];
    // First time we see a fixture (or the very first run): just remember it
    if (!state || !before) continue;
    for (const e of eventsFor(f, before, teams, players)) alerts.push({ fixtureId: f.id, ...e });
  }

  const messages = [];
  for (const alert of alerts) {
    for (const p of phones) {
      if (!(p.matchIds || []).includes(alert.fixtureId)) continue;
      messages.push({
        to: p.token,
        title: alert.title,
        body: alert.body,
        sound: 'default',
        priority: 'high',
        channelId: 'live-matches',
        data: { type: 'live', matchId: `match_${alert.fixtureId}` },
      });
    }
  }

  console.log(`${relevant.length} fixtures checked, ${alerts.length} events, ${phones.length} phones, ${messages.length} notifications`);
  alerts.forEach((a) => console.log(` - [${a.fixtureId}] ${a.title}: ${a.body}`));

  if (messages.length && !DRY_RUN) {
    const results = await sendPush(messages);
    const errors = results.filter((r) => r.status === 'error');
    console.log(`sent ${results.length - errors.length}, failed ${errors.length}`);
    // Phones that uninstalled the app: forget their token
    for (const r of errors) {
      console.log('  error:', r.message, r.details?.error || '');
      if (r.details?.error === 'DeviceNotRegistered') {
        const phone = phones.find((p) => p.token === r.to);
        if (phone) await db(token, 'DELETE', `pushTokens/${phone.uid}`).catch(() => {});
      }
    }
  }

  await saveState(token, newState);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
