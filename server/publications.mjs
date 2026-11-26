const REFRESH_INTERVAL = 15_000;

export function createPublicationFeed(db) {
  const select = db.prepare('SELECT data FROM publications ORDER BY published_at DESC');
  let artists = [];
  let refreshedAt = 0;
  let generation = 0;
  let pending;

  function refresh() {
    if (pending) return pending;
    const version = generation;
    pending = select.all().then(rows => {
      if (version !== generation) return;
      artists = rows.map(row => JSON.parse(row.data));
      refreshedAt = Date.now();
    }).finally(() => { pending = undefined; });
    return pending;
  }

  function read() {
    const age = Date.now() - refreshedAt;
    if (age >= REFRESH_INTERVAL) refresh().catch(() => {});
    return artists;
  }

  async function invalidate() {
    generation++;
    // A pause, sale or withdrawal makes the previous snapshot ineligible for further responses.
    artists = [];
    refreshedAt = 0;
    await pending?.catch(() => {});
    await refresh();
  }

  return { refresh, read, invalidate };
}
