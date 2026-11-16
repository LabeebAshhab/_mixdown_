// How many people are using the app right now, for the number in the header.
//
// The page already asks for its job list every few seconds. Each of those
// requests from a browser with the page in view marks that browser's session
// as here; a mark lapses a few seconds after the last one. Nothing else is
// kept: no history and no list anyone can read, and nothing on disk. Only the
// total ever leaves this file.
const WINDOW_MS = 15_000; // a session counts this long after it last checked in
const PER_ADDRESS = 10; // most sessions counted from one IP address
const MAX_MARKS = 50_000; // memory guard

/** @type {Map<string, {at: number, ip: string}>} session id -> last check-in */
const seen = new Map();

function prune(now) {
  for (const [sid, mark] of seen) if (now - mark.at > WINDOW_MS) seen.delete(sid);
}

/** Note that a session's page is open and in view. */
export function checkIn(sid, ip) {
  const now = Date.now();
  if (!seen.has(sid) && seen.size >= MAX_MARKS) {
    prune(now);
    if (seen.size >= MAX_MARKS) return;
  }
  seen.set(sid, { at: now, ip: ip || '' });
}

/** Seconds a check-in lasts, for the privacy page. */
export const onlineWindowSeconds = WINDOW_MS / 1000;

let cached = { at: 0, marks: -1, busy: -1, count: 0 };

/**
 * People here now: sessions that checked in a moment ago, plus those with a
 * download in progress (a tab left converting in the background still counts).
 * One address is counted at most PER_ADDRESS times, so a single machine
 * cannot make the place look crowded.
 * @param {Iterable<{sid: string, ip: string}>} working sessions with a job queued or running
 */
export function onlineCount(working = []) {
  const now = Date.now();
  const busy = [...working];
  // Asked for by every visitor every few seconds: while nobody new has checked
  // in, it is worked out once a second at most.
  if (now - cached.at < 1000 && cached.marks === seen.size && cached.busy === busy.length) return cached.count;
  prune(now);
  const ips = new Map(); // session id -> address
  for (const [sid, mark] of seen) ips.set(sid, mark.ip);
  for (const w of busy) if (!ips.has(w.sid)) ips.set(w.sid, w.ip || '');
  const perAddress = new Map();
  let count = 0;
  for (const ip of ips.values()) {
    const n = (perAddress.get(ip) || 0) + 1;
    perAddress.set(ip, n);
    if (n <= PER_ADDRESS) count++;
  }
  cached = { at: now, marks: seen.size, busy: busy.length, count };
  return count;
}
