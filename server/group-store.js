'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_GROUP_MESSAGES = 1000;
const SCHEMA = `CREATE TABLE IF NOT EXISTS private_groups (
  id uuid PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS private_groups_updated_idx ON private_groups(updated_at DESC);
CREATE TABLE IF NOT EXISTS private_group_attachments (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES private_groups(id) ON DELETE CASCADE,
  message_id text NOT NULL,
  uploader_id char(64) NOT NULL,
  object_key text NOT NULL UNIQUE,
  ciphertext_size bigint NOT NULL CHECK (ciphertext_size > 0),
  status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'attached')),
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  attached_at bigint
);
CREATE INDEX IF NOT EXISTS private_group_attachments_cleanup_idx
  ON private_group_attachments(status, expires_at);`;

class GroupStore {
  constructor(directory, pool = null) {
    this.file = path.join(directory, 'private-groups.json');
    this.pool = pool;
    this.items = new Map();
  }

  async initialize() {
    if (this.pool) return this.pool.query(SCHEMA);
    try {
      const rows = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const item of Array.isArray(rows) ? rows : []) if (item?.id) this.items.set(item.id, item);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  flush() {
    fs.mkdirSync(path.dirname(this.file), { recursive:true, mode:0o700 });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify([...this.items.values()]), { mode:0o600 });
    fs.renameSync(temp, this.file);
    fs.chmodSync(this.file, 0o600);
  }

  async create(ownerId, encryptedName, members, keyBinding, id = crypto.randomUUID(), now = Date.now()) {
    const item = {
      id, ownerId, encryptedName, keyVersion:1,
      keyBinding,
      requiresRekey:false, members, messages:[], createdAt:now, updatedAt:now,
    };
    if (this.pool) {
      const result = await this.pool.query('INSERT INTO private_groups(id,data,updated_at) VALUES($1,$2::jsonb,$3) ON CONFLICT DO NOTHING',
        [item.id, JSON.stringify(item), now]);
      if (!result.rowCount) {
        const existing = await this.get(id);
        if (existing?.ownerId === ownerId && existing?.keyBinding === keyBinding) return existing;
        throw new Error('private group id already exists');
      }
    } else {
      const existing = this.items.get(id);
      if (existing?.ownerId === ownerId && existing?.keyBinding === keyBinding) return existing;
      if (existing) throw new Error('private group id already exists');
      this.items.set(item.id, item); this.flush();
    }
    return item;
  }

  async get(id) {
    if (this.pool) {
      const { rows } = await this.pool.query('SELECT data FROM private_groups WHERE id=$1', [id]);
      return rows[0]?.data || null;
    }
    return this.items.get(id) || null;
  }

  async listFor(accountId) {
    const all = this.pool
      ? (await this.pool.query("SELECT data FROM private_groups WHERE data->'members' @> $1::jsonb ORDER BY updated_at DESC",
          [JSON.stringify([{ accountId, active:true }])])).rows.map(row => row.data)
      : [...this.items.values()].filter(group => group.members.some(member => member.accountId === accountId && member.active));
    return all.sort((a,b) => b.updatedAt - a.updatedAt);
  }

  async mutate(id, change) {
    if (!this.pool) {
      const current = this.items.get(id);
      if (!current) return null;
      const next = await change(structuredClone(current));
      if (!next) return null;
      this.items.set(id, next); this.flush(); return next;
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT data FROM private_groups WHERE id=$1 FOR UPDATE', [id]);
      if (!rows.length) { await client.query('ROLLBACK'); return null; }
      const next = await change(rows[0].data);
      if (!next) { await client.query('ROLLBACK'); return null; }
      await client.query('UPDATE private_groups SET data=$2::jsonb,updated_at=$3 WHERE id=$1',
        [id, JSON.stringify(next), next.updatedAt]);
      await client.query('COMMIT');
      return next;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally { client.release(); }
  }

  async send(id, accountId, message, now = Date.now()) {
    return this.mutate(id, group => {
      if (group.requiresRekey || !group.members.some(member => member.accountId === accountId && member.active)) return null;
      const existing = group.messages.find(candidate => candidate.id === message.id);
      if (existing) return existing.senderId === accountId ? group : null;
      group.messages.push({ ...message, senderId:accountId, keyVersion:group.keyVersion, createdAt:now });
      if (group.messages.length > MAX_GROUP_MESSAGES) group.messages.splice(0, group.messages.length - MAX_GROUP_MESSAGES);
      group.updatedAt = now;
      return group;
    });
  }

  async createPendingAttachment(groupId, accountId, attachment) {
    if (!this.pool) return false;
    const result = await this.pool.query(`INSERT INTO private_group_attachments (
      id,group_id,message_id,uploader_id,object_key,ciphertext_size,status,created_at,expires_at
    ) VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8) ON CONFLICT (id) DO NOTHING`, [
      attachment.id, groupId, attachment.messageId, accountId, attachment.objectKey,
      attachment.size, attachment.createdAt, attachment.expiresAt,
    ]);
    return result.rowCount === undefined ? true : result.rowCount === 1;
  }

  async pendingAttachment(groupId, accountId, attachmentId, now = Date.now()) {
    if (!this.pool) return null;
    const { rows } = await this.pool.query(`SELECT id,message_id,object_key,ciphertext_size
      FROM private_group_attachments WHERE id=$1 AND group_id=$2 AND uploader_id=$3
        AND status='pending' AND expires_at>$4`, [attachmentId, groupId, accountId, now]);
    if (!rows.length) return null;
    return { id:rows[0].id, messageId:rows[0].message_id, objectKey:rows[0].object_key,
      size:Number(rows[0].ciphertext_size) };
  }

  async markAttachmentAttached(attachmentId, now = Date.now()) {
    if (!this.pool) return false;
    const result = await this.pool.query(`UPDATE private_group_attachments SET status='attached',attached_at=$2
      WHERE id=$1 AND status='pending'`, [attachmentId, now]);
    return result.rowCount === undefined ? true : result.rowCount === 1;
  }

  async attachment(groupId, attachmentId) {
    if (!this.pool) return null;
    const { rows } = await this.pool.query(`SELECT id,message_id,object_key,ciphertext_size
      FROM private_group_attachments WHERE id=$1 AND group_id=$2 AND status='attached'`, [attachmentId, groupId]);
    if (!rows.length) return null;
    return { id:rows[0].id, messageId:rows[0].message_id, objectKey:rows[0].object_key,
      size:Number(rows[0].ciphertext_size) };
  }

  async listAttachments(groupId) {
    if (!this.pool) return [];
    const { rows } = await this.pool.query('SELECT id,object_key FROM private_group_attachments WHERE group_id=$1', [groupId]);
    return rows.map(row => ({ id:row.id, objectKey:row.object_key }));
  }

  async listAttachmentGarbage(now = Date.now(), limit = 100) {
    if (!this.pool) return [];
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const { rows } = await this.pool.query(`SELECT id,object_key FROM private_group_attachments
      WHERE status='pending' AND expires_at<=$1 ORDER BY created_at LIMIT $2`, [now, safeLimit]);
    return rows.map(row => ({ id:row.id, objectKey:row.object_key }));
  }

  async deleteAttachmentRecord(attachmentId) {
    if (this.pool) await this.pool.query('DELETE FROM private_group_attachments WHERE id=$1', [attachmentId]);
  }

  async leave(id, accountId, now = Date.now()) {
    return this.mutate(id, group => {
      const member = group.members.find(candidate => candidate.accountId === accountId && candidate.active);
      if (!member || group.ownerId === accountId) return null;
      member.active = false; member.leftAt = now;
      group.requiresRekey = true; group.updatedAt = now;
      return group;
    });
  }

  async rekey(id, ownerId, removedAccountId, encryptedName, envelopes, now = Date.now()) {
    return this.mutate(id, group => {
      if (group.ownerId !== ownerId) return null;
      const removed = removedAccountId
        ? group.members.find(member => member.accountId === removedAccountId && member.active)
        : null;
      if (removedAccountId && !removed) return null;
      if (removed) { removed.active = false; removed.leftAt = now; }
      const active = group.members.filter(member => member.active && member.accountId !== ownerId);
      if (envelopes.length !== active.length) return null;
      const supplied = new Map(envelopes.map(entry => [entry.accountId, entry]));
      if (active.some(member => !supplied.has(member.accountId))) return null;
      group.keyVersion += 1;
      group.encryptedName = encryptedName;
      for (const member of active) {
        const entry = supplied.get(member.accountId);
        member.wrappedKey = entry.wrappedKey;
        member.wrappedKeys = { ...(member.wrappedKeys || {}), [group.keyVersion]:entry.wrappedKey };
        member.wrapRoomCode = entry.wrapRoomCode;
        member.keyVersion = group.keyVersion;
      }
      const owner = group.members.find(member => member.accountId === ownerId);
      if (owner) owner.keyVersion = group.keyVersion;
      group.requiresRekey = false; group.updatedAt = now;
      return group;
    });
  }

  async remove(id, ownerId) {
    const current = await this.get(id);
    if (!current || current.ownerId !== ownerId) return false;
    if (this.pool) return (await this.pool.query('DELETE FROM private_groups WHERE id=$1', [id])).rowCount === 1;
    this.items.delete(id); this.flush(); return true;
  }
}

module.exports = { GroupStore, SCHEMA, MAX_GROUP_MESSAGES };
