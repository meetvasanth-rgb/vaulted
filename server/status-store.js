'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const SCHEMA = `CREATE TABLE IF NOT EXISTS encrypted_statuses (
  id uuid PRIMARY KEY,
  author_id text NOT NULL,
  entries jsonb NOT NULL,
  viewers jsonb NOT NULL DEFAULT '[]'::jsonb,
  media_id uuid,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL
);
ALTER TABLE encrypted_statuses ADD COLUMN IF NOT EXISTS media_id uuid;
CREATE INDEX IF NOT EXISTS encrypted_statuses_expiry_idx ON encrypted_statuses(expires_at);`;

class StatusStore {
  constructor(directory, pool = null) {
    this.file = path.join(directory, 'encrypted-statuses.json');
    this.pool = pool;
    this.items = new Map();
  }

  async initialize() {
    if (this.pool) {
      await this.pool.query(SCHEMA);
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const item of Array.isArray(parsed) ? parsed : []) this.items.set(item.id, item);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await this.prune();
  }

  flush() {
    fs.mkdirSync(path.dirname(this.file), { recursive:true, mode:0o700 });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify([...this.items.values()]), { mode:0o600 });
    fs.renameSync(temp, this.file);
    fs.chmodSync(this.file, 0o600);
  }

  async publish(authorId, entries, now = Date.now(), mediaId = null) {
    const item = {
      id:crypto.randomUUID(), authorId, entries, viewers:[],
      mediaId, createdAt:now, expiresAt:now + STATUS_TTL_MS,
    };
    if (this.pool) {
      await this.pool.query('INSERT INTO encrypted_statuses(id,author_id,entries,viewers,media_id,created_at,expires_at) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7)',
        [item.id, authorId, JSON.stringify(entries), '[]', mediaId, item.createdAt, item.expiresAt]);
    } else {
      this.items.set(item.id, item);
      try { this.flush(); } catch (error) { this.items.delete(item.id); throw error; }
    }
    return item;
  }

  async listFor(accountId, now = Date.now()) {
    await this.prune(now);
    const rows = this.pool
      ? (await this.pool.query('SELECT id,author_id,entries,viewers,media_id,created_at,expires_at FROM encrypted_statuses WHERE expires_at>$1 AND (author_id=$2 OR entries @> $3::jsonb) ORDER BY created_at ASC',
        [now, accountId, JSON.stringify([{ recipientId:accountId }])])).rows.map(row => ({
          id:row.id, authorId:row.author_id, entries:row.entries || [], viewers:row.viewers || [],
          mediaId:row.media_id || null, createdAt:Number(row.created_at), expiresAt:Number(row.expires_at),
        }))
      : [...this.items.values()].filter(item => item.expiresAt > now &&
          (item.authorId === accountId || item.entries.some(entry => entry.recipientId === accountId)))
        .sort((a,b) => a.createdAt - b.createdAt);
    return rows;
  }

  async markViewed(id, viewerId, now = Date.now()) {
    if (this.pool) {
      const marker = JSON.stringify([{ accountId:viewerId }]);
      const viewer = JSON.stringify([{ accountId:viewerId, viewedAt:now }]);
      const result = await this.pool.query(`UPDATE encrypted_statuses
        SET viewers=CASE WHEN viewers @> $4::jsonb THEN viewers ELSE (viewers || $3::jsonb) END
        WHERE id=$1 AND expires_at>$2 AND author_id<>$5`, [id, now, viewer, marker, viewerId]);
      return result.rowCount === 1;
    }
    const item = this.items.get(id);
    if (!item || item.expiresAt <= now || item.authorId === viewerId) return false;
    if (!item.viewers.some(viewer => viewer.accountId === viewerId)) item.viewers.push({ accountId:viewerId, viewedAt:now });
    this.flush();
    return true;
  }

  async remove(id, authorId) {
    if (this.pool) return (await this.pool.query('DELETE FROM encrypted_statuses WHERE id=$1 AND author_id=$2', [id, authorId])).rowCount === 1;
    const item = this.items.get(id);
    if (!item || item.authorId !== authorId) return false;
    this.items.delete(id); this.flush(); return true;
  }

  async removeAllByAuthor(authorId, client = null) {
    if (this.pool) {
      const result = await (client || this.pool).query('DELETE FROM encrypted_statuses WHERE author_id=$1 RETURNING entries', [authorId]);
      return [...new Set(result.rows.flatMap(row => (row.entries || []).map(entry => entry.recipientId)).filter(Boolean))];
    }
    const recipients = new Set();
    let removed = false;
    for (const [id,item] of this.items) if (item.authorId === authorId) {
      for (const entry of item.entries || []) if (entry.recipientId) recipients.add(entry.recipientId);
      this.items.delete(id); removed = true;
    }
    if (removed) this.flush();
    return [...recipients];
  }

  async owned(id, authorId) {
    if (this.pool) {
      const { rows } = await this.pool.query('SELECT id,media_id FROM encrypted_statuses WHERE id=$1 AND author_id=$2', [id, authorId]);
      return rows.length ? { id:rows[0].id, mediaId:rows[0].media_id || null } : null;
    }
    const item = this.items.get(id);
    return item?.authorId === authorId ? item : null;
  }

  async canAccessMedia(accountId, mediaId, now = Date.now()) {
    if (this.pool) {
      const result = await this.pool.query(`SELECT 1 FROM encrypted_statuses
        WHERE media_id=$1 AND expires_at>$2 AND (author_id=$3 OR entries @> $4::jsonb) LIMIT 1`,
      [mediaId, now, accountId, JSON.stringify([{ recipientId:accountId }])]);
      return result.rows.length === 1;
    }
    return [...this.items.values()].some(item => item.mediaId === mediaId && item.expiresAt > now &&
      (item.authorId === accountId || item.entries.some(entry => entry.recipientId === accountId)));
  }

  async prune(now = Date.now()) {
    if (this.pool) { await this.pool.query('DELETE FROM encrypted_statuses WHERE expires_at<=$1', [now]); return; }
    let changed = false;
    for (const [id,item] of this.items) if (item.expiresAt <= now) { this.items.delete(id); changed = true; }
    if (changed) this.flush();
  }
}

module.exports = { StatusStore, STATUS_TTL_MS, SCHEMA };
