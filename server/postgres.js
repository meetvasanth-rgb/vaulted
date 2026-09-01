'use strict';

const { Pool } = require('pg');
const crypto = require('crypto');

// PostgreSQL contains ciphertext, hashes, delivery state and deletion
// tombstones only. Message plaintext and conversation keys never enter this
// process, so moving persistence out of one Node heap does not weaken E2E.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vaultlix_schema (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id char(64) PRIMARY KEY,
  private_number char(10) NOT NULL UNIQUE,
  display_name varchar(40) NOT NULL,
  auth_verifier text NOT NULL,
  recovery_verifier text NOT NULL,
  password_wrap text NOT NULL,
  recovery_wrap text NOT NULL,
  encrypted_bundle text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  sessions jsonb NOT NULL DEFAULT '[]'::jsonb,
  connection_requests jsonb NOT NULL DEFAULT '[]'::jsonb,
  push_destinations jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id text PRIMARY KEY,
  persistent boolean NOT NULL DEFAULT true,
  delete_timer integer NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  last_message_at bigint NOT NULL DEFAULT 0,
  next_message_sequence bigint NOT NULL DEFAULT 1,
  next_receipt_sequence bigint NOT NULL DEFAULT 1,
  next_reaction_sequence bigint NOT NULL DEFAULT 1,
  next_deletion_sequence bigint NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id text NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  member_slot smallint NOT NULL CHECK (member_slot IN (1,2)),
  token_hash char(64) NOT NULL,
  encrypted_name text,
  public_key text,
  push_state jsonb,
  last_seen bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, member_slot),
  UNIQUE (conversation_id, token_hash)
);

CREATE TABLE IF NOT EXISTS encrypted_messages (
  conversation_id text NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  message_id text NOT NULL,
  sender_token_hash char(64) NOT NULL,
  sequence bigint NOT NULL,
  ciphertext text NOT NULL,
  created_at bigint NOT NULL,
  expires_at bigint,
  view_once boolean NOT NULL DEFAULT false,
  PRIMARY KEY (conversation_id, message_id),
  UNIQUE (conversation_id, sequence)
);
CREATE INDEX IF NOT EXISTS encrypted_messages_sync_idx
  ON encrypted_messages(conversation_id, sequence);

CREATE TABLE IF NOT EXISTS inbox_events (
  account_id char(64) NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  conversation_id text,
  event_type varchar(32) NOT NULL,
  encrypted_payload text,
  created_at bigint NOT NULL,
  expires_at bigint,
  PRIMARY KEY (account_id, sequence)
);
ALTER TABLE inbox_events ALTER COLUMN sequence DROP IDENTITY IF EXISTS;
CREATE INDEX IF NOT EXISTS inbox_events_sync_idx
  ON inbox_events(account_id, sequence);

CREATE TABLE IF NOT EXISTS account_inbox_counters (
  account_id char(64) PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  next_sequence bigint NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS message_receipts (
  conversation_id text NOT NULL,
  message_id text NOT NULL,
  delivered_at bigint,
  read_at bigint,
  receipt_sequence bigint NOT NULL,
  PRIMARY KEY (conversation_id, message_id),
  FOREIGN KEY (conversation_id, message_id)
    REFERENCES encrypted_messages(conversation_id, message_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_reactions (
  conversation_id text NOT NULL,
  message_id text NOT NULL,
  reactor_token_hash char(64) NOT NULL,
  encrypted_reaction text,
  reaction_sequence bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (conversation_id, message_id, reactor_token_hash),
  FOREIGN KEY (conversation_id, message_id)
    REFERENCES encrypted_messages(conversation_id, message_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deletion_tombstones (
  conversation_id text NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  message_id text NOT NULL,
  deletion_sequence bigint NOT NULL,
  deleted_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  PRIMARY KEY (conversation_id, message_id)
);

CREATE TABLE IF NOT EXISTS device_sync_cursors (
  account_id char(64) NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  device_id char(64) NOT NULL,
  inbox_sequence bigint NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL,
  PRIMARY KEY (account_id, device_id)
);

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS push_destinations jsonb NOT NULL DEFAULT '[]'::jsonb;

INSERT INTO vaultlix_schema(version) VALUES (1), (2) ON CONFLICT DO NOTHING;
`;

class PostgresStore {
  constructor(url, options = {}) {
    this.url = url || '';
    this.pool = options.pool || null;
    this.enabled = !!(this.url || this.pool);
  }

  async initialize() {
    if (!this.enabled) return false;
    if (!this.pool) this.pool = new Pool({ connectionString:this.url, max:20, idleTimeoutMillis:30000, connectionTimeoutMillis:10000 });
    await this.pool.query(SCHEMA_SQL);
    return true;
  }

  async loadAccounts() {
    if (!this.enabled) return [];
    const { rows } = await this.pool.query('SELECT * FROM accounts ORDER BY created_at');
    return rows.map(row => [row.account_id, {
      version:2, privateNumber:row.private_number, displayName:row.display_name,
      authVerifier:row.auth_verifier, recoveryVerifier:row.recovery_verifier,
      passwordWrap:row.password_wrap, recoveryWrap:row.recovery_wrap,
      bundle:row.encrypted_bundle, revision:Number(row.revision),
      sessions:row.sessions || [], connectionRequests:row.connection_requests || [],
      pushDestinations:row.push_destinations || [],
      createdAt:Number(row.created_at), updatedAt:Number(row.updated_at),
    }]);
  }

  async saveAccount(accountId, account) {
    if (!this.enabled) return;
    await this.pool.query(`INSERT INTO accounts (
      account_id, private_number, display_name, auth_verifier, recovery_verifier,
      password_wrap, recovery_wrap, encrypted_bundle, revision, sessions,
      connection_requests, push_destinations, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14)
    ON CONFLICT (account_id) DO UPDATE SET
      private_number=EXCLUDED.private_number, display_name=EXCLUDED.display_name,
      auth_verifier=EXCLUDED.auth_verifier, recovery_verifier=EXCLUDED.recovery_verifier,
      password_wrap=EXCLUDED.password_wrap, recovery_wrap=EXCLUDED.recovery_wrap,
      encrypted_bundle=EXCLUDED.encrypted_bundle, revision=EXCLUDED.revision,
      sessions=EXCLUDED.sessions, connection_requests=EXCLUDED.connection_requests,
      push_destinations=EXCLUDED.push_destinations,
      updated_at=EXCLUDED.updated_at`, [
      accountId, account.privateNumber, account.displayName, account.authVerifier,
      account.recoveryVerifier, account.passwordWrap, account.recoveryWrap,
      account.bundle, account.revision, JSON.stringify(account.sessions || []),
      JSON.stringify(account.connectionRequests || []), JSON.stringify(account.pushDestinations || []), account.createdAt, account.updatedAt,
    ]);
  }

  async deleteAccount(accountId) {
    if (this.enabled) await this.pool.query('DELETE FROM accounts WHERE account_id=$1', [accountId]);
  }

  async createConversation(record) {
    if (!this.enabled) return;
    await this.pool.query(`INSERT INTO conversations (
      conversation_id, persistent, delete_timer, created_at, updated_at, last_message_at
    ) VALUES ($1,$2,$3,$4,$4,$5)
    ON CONFLICT (conversation_id) DO NOTHING`, [
      record.id, !!record.persistent, record.deleteTimer || 0,
      record.createdAt, record.lastMessageAt || 0,
    ]);
  }

  async upsertConversationMember(conversationId, slot, token, member) {
    if (!this.enabled) return;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await this.pool.query(`INSERT INTO conversation_members (
      conversation_id, member_slot, token_hash, encrypted_name, public_key,
      push_state, last_seen
    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
    ON CONFLICT (conversation_id, member_slot) DO UPDATE SET
      token_hash=EXCLUDED.token_hash, encrypted_name=EXCLUDED.encrypted_name,
      public_key=EXCLUDED.public_key, push_state=EXCLUDED.push_state,
      last_seen=EXCLUDED.last_seen`, [
      conversationId, slot, tokenHash, member.name || null, member.pubKey || null,
      JSON.stringify({ pushSub:member.pushSub || null, apnsToken:member.apnsToken || null, fcmToken:member.fcmToken || null }),
      member.lastSeen || 0,
    ]);
  }

  async deleteConversationMember(conversationId, slot) {
    if (!this.enabled) return;
    await this.pool.query('DELETE FROM conversation_members WHERE conversation_id=$1 AND member_slot=$2', [conversationId, slot]);
  }

  async appendEncryptedMessage(conversationId, token, message) {
    if (!this.enabled) return;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO encrypted_messages (
        conversation_id, message_id, sender_token_hash, sequence, ciphertext,
        created_at, expires_at, view_once
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (conversation_id, message_id) DO NOTHING`, [
        conversationId, message.id, tokenHash, message.seq, message.content,
        message.ts, message.expiresAt || null, !!message.viewOnce,
      ]);
      await client.query(`UPDATE conversations SET
        updated_at=$2, last_message_at=GREATEST(last_message_at,$2),
        next_message_sequence=GREATEST(next_message_sequence,$3)
        WHERE conversation_id=$1`, [conversationId, message.ts, message.seq + 1]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async deleteEncryptedMessage(conversationId, messageId, deletionSequence, deletedAt, expiresAt) {
    if (!this.enabled) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM encrypted_messages WHERE conversation_id=$1 AND message_id=$2', [conversationId, messageId]);
      await client.query(`INSERT INTO deletion_tombstones (
        conversation_id, message_id, deletion_sequence, deleted_at, expires_at
      ) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (conversation_id,message_id) DO UPDATE SET
        deletion_sequence=GREATEST(deletion_tombstones.deletion_sequence,EXCLUDED.deletion_sequence),
        deleted_at=EXCLUDED.deleted_at, expires_at=EXCLUDED.expires_at`,
      [conversationId, messageId, deletionSequence, deletedAt, expiresAt]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async close() { if (this.pool?.end) await this.pool.end(); }
}

module.exports = { PostgresStore, SCHEMA_SQL };
