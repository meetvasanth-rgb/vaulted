'use strict';

const { Pool } = require('pg');
const crypto = require('crypto');

// PostgreSQL contains ciphertext, hashes, delivery state, deletion
// tombstones, and the intentionally public identity fields (display name and
// optional profile image). Message plaintext and conversation keys never
// enter this process, so moving persistence out of one Node heap does not
// weaken E2E.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vaultlix_schema (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS account_creation_order_seq;

CREATE TABLE IF NOT EXISTS accounts (
  account_id char(64) PRIMARY KEY,
  private_number varchar(10) NOT NULL UNIQUE,
  profile_share_code char(6) UNIQUE,
  display_name varchar(40) NOT NULL,
  profile_image text,
  auth_verifier text NOT NULL,
  recovery_verifier text NOT NULL,
  password_wrap text NOT NULL,
  recovery_wrap text NOT NULL,
  encrypted_bundle text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  sessions jsonb NOT NULL DEFAULT '[]'::jsonb,
  connection_requests jsonb NOT NULL DEFAULT '[]'::jsonb,
  push_destinations jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_active_at bigint NOT NULL,
  number_category varchar(32) NOT NULL DEFAULT 'standard',
  number_protection varchar(32) NOT NULL DEFAULT 'free',
  premium_until bigint,
  reclaim_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  tier varchar(16) NOT NULL DEFAULT 'standard' CHECK (tier IN ('standard', 'reserve', 'founding')),
  is_founding boolean NOT NULL DEFAULT false,
  creation_order bigint NOT NULL DEFAULT nextval('account_creation_order_seq'),
  daily_look_generated_at bigint,
  daily_look_claimed_at bigint,
  daily_look_window_started_at bigint,
  daily_look_generation_count integer NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS profile_share_code char(6);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_profile_share_code_idx
  ON accounts(profile_share_code) WHERE profile_share_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS private_number_lifecycle (
  private_number varchar(10) PRIMARY KEY,
  status varchar(16) NOT NULL CHECK (status IN ('quarantined', 'retired')),
  available_after bigint,
  reason varchar(64) NOT NULL,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS private_number_reservations (
  private_number varchar(10) PRIMARY KEY,
  token_hash char(64) NOT NULL UNIQUE,
  category varchar(32) NOT NULL,
  reserved_until bigint NOT NULL,
  assigned_account_id char(64) REFERENCES accounts(account_id) ON DELETE SET NULL,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS private_number_reservations_expiry_idx
  ON private_number_reservations(reserved_until);

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

CREATE TABLE IF NOT EXISTS encrypted_attachments (
  attachment_id uuid PRIMARY KEY,
  conversation_id text NOT NULL,
  expected_message_id text NOT NULL,
  uploader_token_hash char(64) NOT NULL,
  object_key text NOT NULL UNIQUE,
  ciphertext_size bigint NOT NULL CHECK (ciphertext_size > 0),
  status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'attached')),
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  attached_at bigint
);
CREATE INDEX IF NOT EXISTS encrypted_attachments_conversation_idx
  ON encrypted_attachments(conversation_id, attachment_id);
CREATE INDEX IF NOT EXISTS encrypted_attachments_cleanup_idx
  ON encrypted_attachments(status, expires_at);

CREATE TABLE IF NOT EXISTS encrypted_status_media (
  media_id uuid PRIMARY KEY,
  owner_id char(64) NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  object_key text NOT NULL UNIQUE,
  ciphertext_size bigint NOT NULL CHECK (ciphertext_size > 0),
  status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'attached')),
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  attached_at bigint
);
CREATE INDEX IF NOT EXISTS encrypted_status_media_cleanup_idx
  ON encrypted_status_media(status, expires_at);

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
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS profile_image text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_active_at bigint;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS number_category varchar(32) NOT NULL DEFAULT 'standard';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS number_protection varchar(32) NOT NULL DEFAULT 'free';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS premium_until bigint;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS reclaim_warnings jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE accounts ALTER COLUMN private_number TYPE varchar(10) USING trim(private_number);
ALTER TABLE private_number_lifecycle ALTER COLUMN private_number TYPE varchar(10) USING trim(private_number);
ALTER TABLE private_number_reservations ALTER COLUMN private_number TYPE varchar(10) USING trim(private_number);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tier varchar(16) NOT NULL DEFAULT 'standard';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_founding boolean NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS creation_order bigint;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS daily_look_generated_at bigint;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS daily_look_claimed_at bigint;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS daily_look_window_started_at bigint;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS daily_look_generation_count integer NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS status varchar(16) NOT NULL DEFAULT 'active';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_named boolean NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_activity bigint NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS connected_since bigint;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS total_message_count bigint NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS delete_timer_set_at bigint NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS cleared_at bigint NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS state_version bigint NOT NULL DEFAULT 1;
ALTER TABLE encrypted_messages ADD COLUMN IF NOT EXISTS attachment_id uuid;
ALTER TABLE encrypted_messages ADD COLUMN IF NOT EXISTS delete_timer_seconds integer;
UPDATE encrypted_messages m SET delete_timer_seconds = CASE
  WHEN m.created_at >= c.delete_timer_set_at THEN c.delete_timer ELSE 0 END
FROM conversations c WHERE c.conversation_id=m.conversation_id AND m.delete_timer_seconds IS NULL;
ALTER TABLE accounts ALTER COLUMN creation_order SET DEFAULT nextval('account_creation_order_seq');
WITH ordered AS (
  SELECT account_id, row_number() OVER (ORDER BY created_at, account_id) AS ordinal
  FROM accounts
)
UPDATE accounts SET creation_order=ordered.ordinal
FROM ordered WHERE accounts.account_id=ordered.account_id AND accounts.creation_order IS NULL;
SELECT setval(
  'account_creation_order_seq',
  GREATEST(COALESCE((SELECT max(creation_order) FROM accounts), 1), 1),
  EXISTS (SELECT 1 FROM accounts)
);
ALTER TABLE accounts ALTER COLUMN creation_order SET NOT NULL;
UPDATE accounts SET
  is_founding=creation_order <= 10000,
  tier=CASE
    WHEN number_category <> 'standard' THEN 'reserve'
    WHEN creation_order <= 10000 THEN 'founding'
    ELSE 'standard'
  END;
UPDATE private_number_lifecycle SET status='retired', available_after=NULL WHERE status='quarantined';
UPDATE accounts SET last_active_at=(extract(epoch from clock_timestamp()) * 1000)::bigint WHERE last_active_at IS NULL;
ALTER TABLE accounts ALTER COLUMN last_active_at SET NOT NULL;

INSERT INTO vaultlix_schema(version) VALUES (1), (2), (3), (4), (5), (6) ON CONFLICT DO NOTHING;
`;

function tokenHash(token) {
  const value = String(token || '');
  return /^[a-f0-9]{64}$/.test(value)
    ? value
    : crypto.createHash('sha256').update(value).digest('hex');
}

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
    const missing = await this.pool.query('SELECT account_id FROM accounts WHERE profile_share_code IS NULL ORDER BY created_at');
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (const row of missing.rows) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const bytes = crypto.randomBytes(6);
        let code = '';
        for (const byte of bytes) code += alphabet[byte % alphabet.length];
        try {
          await this.pool.query('UPDATE accounts SET profile_share_code=$2 WHERE account_id=$1 AND profile_share_code IS NULL', [row.account_id, code]);
          break;
        } catch (error) {
          if (error?.code !== '23505' || attempt === 99) throw error;
        }
      }
    }
    const { rows } = await this.pool.query('SELECT * FROM accounts ORDER BY created_at');
    return rows.map(row => [row.account_id, {
      version:2, privateNumber:row.private_number, profileShareCode:row.profile_share_code || null,
      displayName:row.display_name, profileImage:row.profile_image || null,
      authVerifier:row.auth_verifier, recoveryVerifier:row.recovery_verifier,
      passwordWrap:row.password_wrap, recoveryWrap:row.recovery_wrap,
      bundle:row.encrypted_bundle, revision:Number(row.revision),
      sessions:row.sessions || [], connectionRequests:row.connection_requests || [],
      pushDestinations:row.push_destinations || [],
      lastActiveAt:Number(row.last_active_at), numberCategory:row.number_category || 'standard',
      numberProtection:row.number_protection || 'free', premiumUntil:row.premium_until == null ? null : Number(row.premium_until),
      reclaimWarnings:row.reclaim_warnings || [],
      tier:row.tier || 'standard', isFounding:!!row.is_founding,
      creationOrder:Number(row.creation_order),
      dailyLookGeneratedAt:row.daily_look_generated_at == null ? null : Number(row.daily_look_generated_at),
      dailyLookWindowStartedAt:row.daily_look_window_started_at == null ? null : Number(row.daily_look_window_started_at),
      dailyLookGenerationCount:Math.max(0, Number(row.daily_look_generation_count) || 0),
      createdAt:Number(row.created_at), updatedAt:Number(row.updated_at),
    }]);
  }

  async saveAccount(accountId, account, queryClient = this.pool) {
    if (!this.enabled) return;
    await queryClient.query(`INSERT INTO accounts (
      account_id, private_number, profile_share_code, display_name, profile_image, auth_verifier, recovery_verifier,
      password_wrap, recovery_wrap, encrypted_bundle, revision, sessions,
      connection_requests, push_destinations, last_active_at, number_category,
      number_protection, premium_until, reclaim_warnings, tier, is_founding,
      creation_order, daily_look_generated_at, daily_look_window_started_at,
      daily_look_generation_count, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$19::jsonb,$20,$21,$22,$23,$24,$25,$26,$27)
    ON CONFLICT (account_id) DO UPDATE SET
      private_number=EXCLUDED.private_number, profile_share_code=EXCLUDED.profile_share_code,
      display_name=EXCLUDED.display_name,
      profile_image=EXCLUDED.profile_image,
      auth_verifier=EXCLUDED.auth_verifier, recovery_verifier=EXCLUDED.recovery_verifier,
      password_wrap=EXCLUDED.password_wrap, recovery_wrap=EXCLUDED.recovery_wrap,
      encrypted_bundle=EXCLUDED.encrypted_bundle, revision=EXCLUDED.revision,
      sessions=EXCLUDED.sessions, connection_requests=EXCLUDED.connection_requests,
      push_destinations=EXCLUDED.push_destinations,
      last_active_at=EXCLUDED.last_active_at, number_category=EXCLUDED.number_category,
      number_protection=EXCLUDED.number_protection, premium_until=EXCLUDED.premium_until,
      reclaim_warnings=EXCLUDED.reclaim_warnings,
      tier=EXCLUDED.tier, is_founding=EXCLUDED.is_founding,
      creation_order=EXCLUDED.creation_order,
      daily_look_generated_at=EXCLUDED.daily_look_generated_at,
      daily_look_window_started_at=EXCLUDED.daily_look_window_started_at,
      daily_look_generation_count=EXCLUDED.daily_look_generation_count,
      updated_at=EXCLUDED.updated_at`, [
      accountId, account.privateNumber, account.profileShareCode || null, account.displayName, account.profileImage || null, account.authVerifier,
      account.recoveryVerifier, account.passwordWrap, account.recoveryWrap,
      account.bundle, account.revision, JSON.stringify(account.sessions || []),
      JSON.stringify(account.connectionRequests || []), JSON.stringify(account.pushDestinations || []),
      account.lastActiveAt || account.updatedAt || account.createdAt, account.numberCategory || 'standard',
      account.numberProtection || 'free', account.premiumUntil || null, JSON.stringify(account.reclaimWarnings || []),
      account.tier || 'standard', !!account.isFounding, account.creationOrder,
      account.dailyLookGeneratedAt || null, account.dailyLookWindowStartedAt || null,
      Math.max(0, Number(account.dailyLookGenerationCount) || 0), account.createdAt, account.updatedAt,
    ]);
  }

  async claimDailyLook(accountId, now, dayStartedAt, staleClaimBefore, dailyLimit) {
    if (!this.enabled) return true;
    const { rows } = await this.pool.query(`UPDATE accounts SET daily_look_claimed_at=$2
      WHERE account_id=$1
        AND (daily_look_claimed_at IS NULL OR daily_look_claimed_at <= $4)
        AND (daily_look_window_started_at IS NULL OR daily_look_window_started_at <> $3
          OR daily_look_generation_count < $5)
      RETURNING account_id`, [accountId, now, dayStartedAt, staleClaimBefore, dailyLimit]);
    return rows.length === 1;
  }

  async completeDailyLook(accountId, now, dayStartedAt) {
    if (!this.enabled) return;
    await this.pool.query(`UPDATE accounts SET daily_look_generated_at=$2,
      daily_look_claimed_at=NULL,
      daily_look_window_started_at=CASE
        WHEN daily_look_window_started_at IS NULL OR daily_look_window_started_at <> $3 THEN $3
        ELSE daily_look_window_started_at END,
      daily_look_generation_count=CASE
        WHEN daily_look_window_started_at IS NULL OR daily_look_window_started_at <> $3 THEN 1
        ELSE daily_look_generation_count + 1 END
      WHERE account_id=$1`, [accountId, now, dayStartedAt]);
  }

  async releaseDailyLookClaim(accountId) {
    if (!this.enabled) return;
    await this.pool.query('UPDATE accounts SET daily_look_claimed_at=NULL WHERE account_id=$1', [accountId]);
  }

  async allocateAccountCreationOrder() {
    if (!this.enabled) return null;
    const { rows } = await this.pool.query("SELECT nextval('account_creation_order_seq') AS creation_order");
    return Number(rows[0].creation_order);
  }

  async reservePrivateNumber(privateNumber, tokenHash, category, reservedUntil) {
    if (!this.enabled) return true;
    const { rows } = await this.pool.query(`INSERT INTO private_number_reservations (
      private_number, token_hash, category, reserved_until, created_at
    ) SELECT $1::varchar(10),$2::char(64),$3::varchar(32),$4::bigint,$5::bigint
      WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE private_number=$1::varchar(10))
        AND NOT EXISTS (SELECT 1 FROM private_number_lifecycle WHERE private_number=$1::varchar(10))
    ON CONFLICT (private_number) DO UPDATE SET
      token_hash=EXCLUDED.token_hash, category=EXCLUDED.category,
      reserved_until=EXCLUDED.reserved_until, created_at=EXCLUDED.created_at
    WHERE private_number_reservations.assigned_account_id IS NULL
      AND private_number_reservations.reserved_until < $5::bigint
    RETURNING private_number`, [privateNumber, tokenHash, category, reservedUntil, Date.now()]);
    return rows.length === 1;
  }

  async verifyPrivateNumberReservation(privateNumber, tokenHash, now = Date.now()) {
    if (!this.enabled) return true;
    const { rows } = await this.pool.query(`SELECT category FROM private_number_reservations
      WHERE private_number=$1 AND token_hash=$2 AND reserved_until >= $3
        AND assigned_account_id IS NULL`, [privateNumber, tokenHash, now]);
    return rows.length === 1 ? rows[0].category : null;
  }

  async registerReservedAccount(accountId, account, tokenHash) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const key of [`signup-account:${accountId}`, `signup-number:${account.privateNumber}`].sort()) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
      }
      const existing = await client.query('SELECT account_id FROM accounts WHERE account_id=$1 OR private_number=$2', [accountId, account.privateNumber]);
      const retired = await client.query('SELECT private_number FROM private_number_lifecycle WHERE private_number=$1', [account.privateNumber]);
      const reservation = await client.query('SELECT * FROM private_number_reservations WHERE private_number=$1 FOR UPDATE', [account.privateNumber]);
      const row = reservation.rows[0];
      if (existing.rows.length || retired.rows.length ||
          (tokenHash ? !row || row.token_hash !== tokenHash || Number(row.reserved_until) < Date.now() || row.assigned_account_id : row && (row.assigned_account_id || Number(row.reserved_until) >= Date.now()))) {
        await client.query('ROLLBACK'); return false;
      }
      await this.saveAccount(accountId, account, client);
      if (tokenHash) await client.query('UPDATE private_number_reservations SET assigned_account_id=$2 WHERE private_number=$1', [account.privateNumber, accountId]);
      await client.query('COMMIT'); return true;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23505') return false;
      throw error;
    } finally { client.release(); }
  }

  async completePrivateNumberReservation(privateNumber, tokenHash, accountId) {
    if (!this.enabled) return;
    await this.pool.query(`UPDATE private_number_reservations
      SET assigned_account_id=$3 WHERE private_number=$1 AND token_hash=$2`,
    [privateNumber, tokenHash, accountId]);
  }

  async deleteAccount(accountId) {
    if (this.enabled) await this.pool.query('DELETE FROM accounts WHERE account_id=$1', [accountId]);
  }

  async releasePrivateNumber(accountId, privateNumber, lifecycle) {
    if (!this.enabled) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO private_number_lifecycle (
        private_number, status, available_after, reason, created_at
      ) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (private_number) DO UPDATE SET
        status=EXCLUDED.status, available_after=EXCLUDED.available_after,
        reason=EXCLUDED.reason, created_at=EXCLUDED.created_at`, [
        privateNumber, lifecycle.status, lifecycle.availableAfter || null, lifecycle.reason, lifecycle.createdAt,
      ]);
      await client.query('DELETE FROM accounts WHERE account_id=$1', [accountId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createConversation(record, client = this.pool) {
    if (!this.enabled) return true;
    const { rows } = await client.query(`INSERT INTO conversations (
      conversation_id, persistent, delete_timer, created_at, updated_at, last_message_at
    ) VALUES ($1,$2,$3,$4,$4,$5)
    ON CONFLICT (conversation_id) DO NOTHING
    RETURNING conversation_id`, [
      record.id, !!record.persistent, record.deleteTimer || 0,
      record.createdAt, record.lastMessageAt || 0,
    ]);
    return rows.length === 1;
  }

  async conversationExists(conversationId) {
    if (!this.enabled) return false;
    const { rows } = await this.pool.query(`SELECT 1 FROM conversations
      WHERE conversation_id=$1 AND status='active'`, [conversationId]);
    return rows.length === 1;
  }

  async countActiveConversations(client = this.pool) {
    if (!this.enabled) return 0;
    const { rows } = await client.query(`SELECT count(*)::bigint AS count
      FROM conversations WHERE status='active'`);
    return Number(rows[0]?.count || 0);
  }

  async conversationStats(activeCutoff) {
    if (!this.enabled) return null;
    const { rows } = await this.pool.query(`SELECT
      count(*)::bigint AS active_conversations,
      count(*) FILTER (WHERE persistent)::bigint AS permanent_conversations,
      count(*) FILTER (WHERE NOT persistent)::bigint AS temporary_conversations,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM conversation_members m WHERE m.conversation_id=c.conversation_id
      ))::bigint AS occupied_conversations,
      COALESCE((SELECT count(*) FROM encrypted_messages),0)::bigint AS stored_messages,
      COALESCE((SELECT count(*) FROM conversation_members WHERE last_seen >= $1),0)::bigint AS active_members
      FROM conversations c WHERE status='active'`, [activeCutoff]);
    const row = rows[0] || {};
    return {
      activeConversations:Number(row.active_conversations || 0),
      permanentConversations:Number(row.permanent_conversations || 0),
      temporaryConversations:Number(row.temporary_conversations || 0),
      occupiedConversations:Number(row.occupied_conversations || 0),
      storedMessages:Number(row.stored_messages || 0),
      activeMembers:Number(row.active_members || 0),
    };
  }

  async withConversationLock(conversationId, operation) {
    if (!this.enabled) return operation(null);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // A transaction-scoped advisory lock serializes every mutation for one
      // conversation across all web replicas without retaining credentials
      // or relying on sticky sessions.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [conversationId]);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async withOptionalTransaction(client, operation) {
    if (client) return operation(client);
    const ownedClient = await this.pool.connect();
    try {
      await ownedClient.query('BEGIN');
      const result = await operation(ownedClient);
      await ownedClient.query('COMMIT');
      return result;
    } catch (error) {
      await ownedClient.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      ownedClient.release();
    }
  }

  async loadConversation(conversationId, client = this.pool) {
    if (!this.enabled) return null;
    const { rows } = await client.query(`SELECT * FROM conversations
      WHERE conversation_id=$1 AND status='active'`, [conversationId]);
    if (!rows.length) return null;
    const row = rows[0];
    const memberResult = await client.query(`SELECT * FROM conversation_members
      WHERE conversation_id=$1 ORDER BY member_slot`, [conversationId]);
    return {
      id:conversationId,
      persistent:!!row.persistent,
      isNamed:!!row.is_named,
      createdAt:Number(row.created_at),
      lastActivity:Number(row.last_activity || row.updated_at),
      connectedSince:row.connected_since == null ? null : Number(row.connected_since),
      totalMessageCount:Number(row.total_message_count || 0),
      lastMessageAt:Number(row.last_message_at || 0),
      deleteTimer:Number(row.delete_timer || 0),
      deleteTimerSetAt:Number(row.delete_timer_set_at || row.created_at),
      clearedAt:Number(row.cleared_at || 0),
      passwordHash:row.password_hash || null,
      seq:Math.max(0, Number(row.next_message_sequence || 1) - 1),
      reactionSeq:Math.max(0, Number(row.next_reaction_sequence || 1) - 1),
      deletionSeq:Math.max(0, Number(row.next_deletion_sequence || 1) - 1),
      stateVersion:Number(row.state_version || 1),
      members:memberResult.rows.map(member => {
        const push = member.push_state || {};
        return [member.token_hash, {
          slot:Number(member.member_slot), name:member.encrypted_name || null,
          pubKey:member.public_key || null, lastSeen:Number(member.last_seen || 0),
          pushSub:push.pushSub || null, fcmToken:push.fcmToken || null,
          apnsToken:push.apnsToken || null, apnsEnvironment:push.apnsEnvironment || null,
          voipToken:push.voipToken || null, voipEnvironment:push.voipEnvironment || null,
          nativeRoomHandle:push.nativeRoomHandle || null,
        }];
      }),
    };
  }

  async saveConversation(conversationId, room, client = this.pool) {
    if (!this.enabled) return;
    const now = Date.now();
    await client.query(`UPDATE conversations SET
      persistent=$2, is_named=$3, delete_timer=$4, last_activity=$5,
      connected_since=$6, total_message_count=$7,
      last_message_at=GREATEST(last_message_at,$8), delete_timer_set_at=$9,
      cleared_at=$10, password_hash=$11, updated_at=$12,
      next_message_sequence=GREATEST(next_message_sequence,$13),
      next_reaction_sequence=GREATEST(next_reaction_sequence,$14),
      next_deletion_sequence=GREATEST(next_deletion_sequence,$15),
      state_version=state_version+1
      WHERE conversation_id=$1 AND status='active'`, [
      conversationId, !!room.persistent, !!room.isNamed, room.deleteTimer || 0,
      room.lastActivity || now, room.connectedSince || null,
      room.totalMessageCount || 0, room.lastMessageAt || 0,
      room.deleteTimerSetAt || 0, room.clearedAt || 0,
      room.passwordHash || null, now, (room.seq || 0) + 1,
      (room.reactionSeq || 0) + 1, (room.deletionSeq || 0) + 1,
    ]);
    for (const [memberToken, member] of room.members || []) {
      await this.upsertConversationMember(conversationId, member.slot, memberToken, member, client);
    }
  }

  async deleteConversation(conversationId, client = this.pool) {
    if (this.enabled) await client.query('DELETE FROM conversations WHERE conversation_id=$1', [conversationId]);
  }

  async sweepExpiredConversations(now, namedTtl, ordinaryTtl) {
    if (!this.enabled) return [];
    const { rows } = await this.pool.query(`DELETE FROM conversations
      WHERE persistent=false AND status='active' AND
        (($1::bigint-last_activity) > CASE WHEN is_named THEN $2::bigint ELSE $3::bigint END)
      RETURNING conversation_id`, [now, namedTtl, ordinaryTtl]);
    return rows.map(row => row.conversation_id);
  }

  async expireDisappearingMessages(now, tombstoneTtl, limit = 500) {
    if (!this.enabled) return [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`SELECT m.conversation_id,m.message_id
        FROM encrypted_messages m
        JOIN conversations c ON c.conversation_id=m.conversation_id
        JOIN message_receipts r ON r.conversation_id=m.conversation_id AND r.message_id=m.message_id
        WHERE c.status='active' AND m.delete_timer_seconds>0
          AND r.read_at IS NOT NULL AND r.read_at + (m.delete_timer_seconds::bigint * 1000) <= $1
        ORDER BY r.read_at LIMIT $2 FOR UPDATE OF m SKIP LOCKED`, [now, limit]);
      const affected = new Set();
      for (const row of rows) {
        const allocated = await client.query(`UPDATE conversations SET
          next_deletion_sequence=next_deletion_sequence+1, updated_at=$2
          WHERE conversation_id=$1 RETURNING next_deletion_sequence-1 AS sequence`,
        [row.conversation_id, now]);
        const sequence = Number(allocated.rows[0]?.sequence || 0);
        await client.query('DELETE FROM encrypted_messages WHERE conversation_id=$1 AND message_id=$2', [row.conversation_id, row.message_id]);
        await client.query(`INSERT INTO deletion_tombstones
          (conversation_id,message_id,deletion_sequence,deleted_at,expires_at)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT (conversation_id,message_id) DO NOTHING`,
        [row.conversation_id, row.message_id, sequence, now, now + tombstoneTtl]);
        affected.add(row.conversation_id);
      }
      await client.query('COMMIT');
      return [...affected];
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async upsertConversationMember(conversationId, slot, token, member, client = this.pool) {
    if (!this.enabled) return;
    const memberTokenHash = tokenHash(token);
    await client.query(`INSERT INTO conversation_members (
      conversation_id, member_slot, token_hash, encrypted_name, public_key,
      push_state, last_seen
    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
    ON CONFLICT (conversation_id, member_slot) DO UPDATE SET
      token_hash=EXCLUDED.token_hash, encrypted_name=EXCLUDED.encrypted_name,
      public_key=EXCLUDED.public_key, push_state=EXCLUDED.push_state,
      last_seen=EXCLUDED.last_seen`, [
      conversationId, slot, memberTokenHash, member.name || null, member.pubKey || null,
      JSON.stringify({
        pushSub:member.pushSub || null, apnsToken:member.apnsToken || null,
        apnsEnvironment:member.apnsEnvironment || null, fcmToken:member.fcmToken || null,
        voipToken:member.voipToken || null, voipEnvironment:member.voipEnvironment || null,
        nativeRoomHandle:member.nativeRoomHandle || null,
      }),
      member.lastSeen || 0,
    ]);
  }

  async deleteConversationMember(conversationId, slot, client = this.pool) {
    if (!this.enabled) return;
    await client.query('DELETE FROM conversation_members WHERE conversation_id=$1 AND member_slot=$2', [conversationId, slot]);
  }

  async createPendingAttachment(conversationId, token, attachment, client = this.pool) {
    if (!this.enabled) return false;
    const result = await client.query(`INSERT INTO encrypted_attachments (
      attachment_id, conversation_id, expected_message_id, uploader_token_hash,
      object_key, ciphertext_size, status, created_at, expires_at
    ) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8)
    ON CONFLICT (attachment_id) DO NOTHING`, [
      attachment.id, conversationId, attachment.messageId, tokenHash(token),
      attachment.objectKey, attachment.size, attachment.createdAt, attachment.expiresAt,
    ]);
    return result.rowCount === undefined ? true : result.rowCount === 1;
  }

  async pendingAttachment(conversationId, token, attachmentId, now = Date.now(), client = this.pool) {
    if (!this.enabled) return null;
    const { rows } = await client.query(`SELECT attachment_id,conversation_id,expected_message_id,
      object_key,ciphertext_size,status,expires_at
      FROM encrypted_attachments
      WHERE attachment_id=$1 AND conversation_id=$2 AND uploader_token_hash=$3
        AND status='pending' AND expires_at>$4`, [attachmentId, conversationId, tokenHash(token), now]);
    if (!rows.length) return null;
    const row = rows[0];
    return {
      id:row.attachment_id, conversationId:row.conversation_id,
      messageId:row.expected_message_id, objectKey:row.object_key,
      size:Number(row.ciphertext_size), status:row.status, expiresAt:Number(row.expires_at),
    };
  }

  async attachmentForMessage(conversationId, attachmentId, client = this.pool) {
    if (!this.enabled) return null;
    const { rows } = await client.query(`SELECT a.attachment_id,a.object_key,a.ciphertext_size
      FROM encrypted_attachments a
      JOIN encrypted_messages m ON m.conversation_id=a.conversation_id
        AND m.attachment_id=a.attachment_id
      WHERE a.attachment_id=$1 AND a.conversation_id=$2 AND a.status='attached'`,
    [attachmentId, conversationId]);
    if (!rows.length) return null;
    return { id:rows[0].attachment_id, objectKey:rows[0].object_key, size:Number(rows[0].ciphertext_size) };
  }

  async listInlinePayloadCandidates(limit = 25, minimumBytes = 32768, client = this.pool) {
    if (!this.enabled) return [];
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
    const { rows } = await client.query(`SELECT conversation_id,message_id,ciphertext
      FROM encrypted_messages
      WHERE attachment_id IS NULL AND ciphertext NOT LIKE 'obj:v1:%'
        AND octet_length(ciphertext)>=$1
      ORDER BY created_at LIMIT $2`, [minimumBytes, safeLimit]);
    return rows.map(row => ({ conversationId:row.conversation_id, messageId:row.message_id, ciphertext:row.ciphertext }));
  }

  async externalizeMessagePayload(candidate, attachment, client = this.pool) {
    if (!this.enabled) return false;
    return this.withOptionalTransaction(client === this.pool ? null : client, async transaction => {
      await transaction.query(`INSERT INTO encrypted_attachments (
        attachment_id,conversation_id,expected_message_id,uploader_token_hash,
        object_key,ciphertext_size,status,created_at,expires_at,attached_at
      ) SELECT $1,$2,$3,sender_token_hash,$4,$5,'attached',$6,$7,$6
        FROM encrypted_messages
        WHERE conversation_id=$2 AND message_id=$3 AND attachment_id IS NULL`, [
        attachment.id, candidate.conversationId, candidate.messageId, attachment.objectKey,
        attachment.size, attachment.createdAt, attachment.expiresAt,
      ]);
      const updated = await transaction.query(`UPDATE encrypted_messages
        SET ciphertext=$4,attachment_id=$3
        WHERE conversation_id=$1 AND message_id=$2 AND attachment_id IS NULL`, [
        candidate.conversationId, candidate.messageId, attachment.id, `obj:v1:${attachment.id}`,
      ]);
      if (updated.rowCount === 0) {
        await transaction.query('DELETE FROM encrypted_attachments WHERE attachment_id=$1', [attachment.id]);
        return false;
      }
      return true;
    });
  }

  async listAttachmentGarbage(now = Date.now(), limit = 100, client = this.pool) {
    if (!this.enabled) return [];
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const { rows } = await client.query(`SELECT a.attachment_id,a.object_key
      FROM encrypted_attachments a
      LEFT JOIN encrypted_messages m ON m.conversation_id=a.conversation_id
        AND m.attachment_id=a.attachment_id
      LEFT JOIN conversations c ON c.conversation_id=a.conversation_id
      WHERE (a.status='pending' AND a.expires_at<=$1)
        OR (a.status='attached' AND (m.message_id IS NULL OR c.conversation_id IS NULL))
      ORDER BY a.created_at LIMIT $2`, [now, safeLimit]);
    return rows.map(row => ({ id:row.attachment_id, objectKey:row.object_key }));
  }

  async deleteAttachmentRecord(attachmentId, client = this.pool) {
    if (this.enabled) await client.query('DELETE FROM encrypted_attachments WHERE attachment_id=$1', [attachmentId]);
  }

  async createPendingStatusMedia(ownerId, media, client = this.pool) {
    if (!this.enabled) return false;
    const result = await client.query(`INSERT INTO encrypted_status_media (
      media_id,owner_id,object_key,ciphertext_size,status,created_at,expires_at
    ) VALUES ($1,$2,$3,$4,'pending',$5,$6) ON CONFLICT (media_id) DO NOTHING`,
    [media.id, ownerId, media.objectKey, media.size, media.createdAt, media.expiresAt]);
    return result.rowCount === undefined ? true : result.rowCount === 1;
  }

  async pendingStatusMedia(ownerId, mediaId, now = Date.now(), client = this.pool) {
    if (!this.enabled) return null;
    const { rows } = await client.query(`SELECT media_id,object_key,ciphertext_size,expires_at
      FROM encrypted_status_media WHERE media_id=$1 AND owner_id=$2
        AND status='pending' AND expires_at>$3`, [mediaId, ownerId, now]);
    if (!rows.length) return null;
    return { id:rows[0].media_id, objectKey:rows[0].object_key, size:Number(rows[0].ciphertext_size), expiresAt:Number(rows[0].expires_at) };
  }

  async attachStatusMedia(ownerId, mediaId, expiresAt, now = Date.now(), client = this.pool) {
    if (!this.enabled) return false;
    const result = await client.query(`UPDATE encrypted_status_media SET status='attached',attached_at=$4,expires_at=$3
      WHERE media_id=$1 AND owner_id=$2 AND status='pending' AND expires_at>$4`, [mediaId, ownerId, expiresAt, now]);
    return result.rowCount === undefined ? true : result.rowCount === 1;
  }

  async statusMedia(mediaId, client = this.pool) {
    if (!this.enabled) return null;
    const { rows } = await client.query(`SELECT media_id,object_key,ciphertext_size FROM encrypted_status_media
      WHERE media_id=$1 AND status='attached'`, [mediaId]);
    return rows.length ? { id:rows[0].media_id, objectKey:rows[0].object_key, size:Number(rows[0].ciphertext_size) } : null;
  }

  async listStatusMediaGarbage(now = Date.now(), limit = 100, client = this.pool) {
    if (!this.enabled) return [];
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const { rows } = await client.query(`SELECT m.media_id,m.object_key FROM encrypted_status_media m
      LEFT JOIN encrypted_statuses s ON s.media_id=m.media_id
      WHERE (m.status='pending' AND m.expires_at<=$1)
        OR (m.status='attached' AND (m.expires_at<=$1 OR s.id IS NULL))
      ORDER BY m.created_at LIMIT $2`, [now, safeLimit]);
    return rows.map(row => ({ id:row.media_id, objectKey:row.object_key }));
  }

  async deleteStatusMediaRecord(mediaId, client = this.pool) {
    if (this.enabled) await client.query('DELETE FROM encrypted_status_media WHERE media_id=$1', [mediaId]);
  }

  async appendEncryptedMessage(conversationId, token, message, transactionClient = null) {
    if (!this.enabled) return;
    const senderTokenHash = tokenHash(token);
    return this.withOptionalTransaction(transactionClient, async client => {
      const allocated = await client.query(`UPDATE conversations SET
        next_message_sequence=next_message_sequence+1,
        updated_at=GREATEST(updated_at,$2), last_message_at=GREATEST(last_message_at,$2)
        WHERE conversation_id=$1 AND status='active'
        RETURNING next_message_sequence-1 AS sequence`, [conversationId, message.ts]);
      // Test doubles and rolling-schema migrations may not return the new
      // allocation row yet; retain the supplied sequence only for that
      // compatibility case. Production PostgreSQL always returns it.
      const sequence = allocated.rows.length ? Number(allocated.rows[0].sequence) : Number(message.seq);
      if (message.attachmentId) {
        const claimed = await client.query(`UPDATE encrypted_attachments SET
          status='attached',attached_at=$4,expires_at=$5
          WHERE attachment_id=$1 AND conversation_id=$2 AND expected_message_id=$3
            AND uploader_token_hash=$6 AND status='pending' AND expires_at>$4`, [
          message.attachmentId, conversationId, message.id, message.ts,
          message.expiresAt || Number.MAX_SAFE_INTEGER, senderTokenHash,
        ]);
        if (claimed.rowCount !== undefined && claimed.rowCount !== 1) throw new Error('Attachment claim is invalid or expired.');
      }
      await client.query(`INSERT INTO encrypted_messages (
        conversation_id, message_id, sender_token_hash, sequence, ciphertext,
        created_at, expires_at, view_once, attachment_id, delete_timer_seconds
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (conversation_id, message_id) DO NOTHING`, [
        conversationId, message.id, senderTokenHash, sequence, message.content,
        message.ts, message.expiresAt || null, !!message.viewOnce, message.attachmentId || null, message.deleteTimerSeconds || 0,
      ]);
      return sequence;
    });
  }

  async loadEncryptedMessages(conversationId, limit = 100, now = Date.now(), client = this.pool) {
    if (!this.enabled) return [];
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 100));
    const { rows } = await client.query(`SELECT * FROM (
      SELECT conversation_id, message_id, sender_token_hash, sequence,
        ciphertext, created_at, expires_at, view_once, attachment_id, delete_timer_seconds
      FROM encrypted_messages
      WHERE conversation_id=$1 AND (expires_at IS NULL OR expires_at > $2)
      ORDER BY sequence DESC
      LIMIT $3
    ) AS recent_messages ORDER BY sequence ASC`, [conversationId, now, safeLimit]);
    const messageIds = rows.map(row => row.message_id);
    const receipts = messageIds.length ? await client.query(`SELECT * FROM message_receipts
      WHERE conversation_id=$1 AND message_id=ANY($2::text[])`, [conversationId, messageIds]) : { rows:[] };
    const reactions = messageIds.length ? await client.query(`SELECT * FROM message_reactions
      WHERE conversation_id=$1 AND message_id=ANY($2::text[])`, [conversationId, messageIds]) : { rows:[] };
    const receiptByMessage = new Map(receipts.rows
      .filter(receipt => receipt.receipt_sequence !== undefined)
      .map(receipt => [receipt.message_id, receipt]));
    const reactionsByMessage = new Map();
    for (const reaction of reactions.rows.filter(item => item.reaction_sequence !== undefined)) {
      if (!reactionsByMessage.has(reaction.message_id)) reactionsByMessage.set(reaction.message_id, {});
      if (reaction.encrypted_reaction) reactionsByMessage.get(reaction.message_id)[reaction.reactor_token_hash] = reaction.encrypted_reaction;
    }
    return rows.map(row => {
      const receipt = receiptByMessage.get(row.message_id);
      const messageReactions = reactionsByMessage.get(row.message_id) || {};
      const value = {
      id:row.message_id,
      senderTokenHash:row.sender_token_hash,
      seq:Number(row.sequence),
      content:row.ciphertext,
      ts:Number(row.created_at),
      expiresAt:row.expires_at == null ? null : Number(row.expires_at),
      viewOnce:!!row.view_once,
      deleteTimerSeconds:Number(row.delete_timer_seconds || 0),
      };
      if (row.attachment_id) value.attachmentId = row.attachment_id;
      if (receipt) {
        value.deliveredAt = receipt.delivered_at == null ? null : Number(receipt.delivered_at);
        value.readAt = receipt.read_at == null ? null : Number(receipt.read_at);
        value.receiptSequence = Number(receipt.receipt_sequence || 0);
      }
      if (Object.keys(messageReactions).length) {
        value.reactions = messageReactions;
        value.reactionSequence = Math.max(0, ...reactions.rows.filter(item => item.message_id === row.message_id).map(item => Number(item.reaction_sequence) || 0));
      }
      return value;
    });
  }

  async markMessagesDelivered(conversationId, messageIds, at, transactionClient = null) {
    if (!this.enabled || !messageIds.length) return 0;
    return this.withOptionalTransaction(transactionClient, async client => {
      const sequence = await client.query(`UPDATE conversations
        SET next_receipt_sequence=next_receipt_sequence+1, updated_at=$2
        WHERE conversation_id=$1 RETURNING next_receipt_sequence-1 AS sequence`, [conversationId, at]);
      const receiptSequence = Number(sequence.rows[0]?.sequence || 0);
      await client.query(`INSERT INTO message_receipts
        (conversation_id,message_id,delivered_at,read_at,receipt_sequence)
        SELECT $1, message_id, $3, NULL, $4 FROM encrypted_messages
        WHERE conversation_id=$1 AND message_id=ANY($2::text[])
        ON CONFLICT (conversation_id,message_id) DO UPDATE SET
          delivered_at=COALESCE(message_receipts.delivered_at,EXCLUDED.delivered_at),
          receipt_sequence=GREATEST(message_receipts.receipt_sequence,EXCLUDED.receipt_sequence)`,
      [conversationId, messageIds, at, receiptSequence]);
      return receiptSequence;
    });
  }

  async markMessagesRead(conversationId, messageIds, at, transactionClient = null) {
    if (!this.enabled || !messageIds.length) return 0;
    return this.withOptionalTransaction(transactionClient, async client => {
      const sequence = await client.query(`UPDATE conversations
        SET next_receipt_sequence=next_receipt_sequence+1, updated_at=$2
        WHERE conversation_id=$1 RETURNING next_receipt_sequence-1 AS sequence`, [conversationId, at]);
      const receiptSequence = Number(sequence.rows[0]?.sequence || 0);
      await client.query(`INSERT INTO message_receipts
        (conversation_id,message_id,delivered_at,read_at,receipt_sequence)
        SELECT $1, message_id, $3, $3, $4 FROM encrypted_messages
        WHERE conversation_id=$1 AND message_id=ANY($2::text[])
        ON CONFLICT (conversation_id,message_id) DO UPDATE SET
          delivered_at=COALESCE(message_receipts.delivered_at,EXCLUDED.delivered_at),
          read_at=COALESCE(message_receipts.read_at,EXCLUDED.read_at),
          receipt_sequence=GREATEST(message_receipts.receipt_sequence,EXCLUDED.receipt_sequence)`,
      [conversationId, messageIds, at, receiptSequence]);
      return receiptSequence;
    });
  }

  async setMessageReaction(conversationId, messageId, token, reaction, at, transactionClient = null) {
    if (!this.enabled) return 0;
    return this.withOptionalTransaction(transactionClient, async client => {
      const sequence = await client.query(`UPDATE conversations
        SET next_reaction_sequence=next_reaction_sequence+1, updated_at=$2
        WHERE conversation_id=$1 RETURNING next_reaction_sequence-1 AS sequence`, [conversationId, at]);
      const reactionSequence = Number(sequence.rows[0]?.sequence || 0);
      const reactorTokenHash = tokenHash(token);
      if (reaction) {
        await client.query(`INSERT INTO message_reactions
          (conversation_id,message_id,reactor_token_hash,encrypted_reaction,reaction_sequence,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (conversation_id,message_id,reactor_token_hash) DO UPDATE SET
            encrypted_reaction=EXCLUDED.encrypted_reaction,
            reaction_sequence=EXCLUDED.reaction_sequence, updated_at=EXCLUDED.updated_at`,
        [conversationId, messageId, reactorTokenHash, reaction, reactionSequence, at]);
      } else {
        await client.query(`DELETE FROM message_reactions
          WHERE conversation_id=$1 AND message_id=$2 AND reactor_token_hash=$3`,
        [conversationId, messageId, reactorTokenHash]);
      }
      return reactionSequence;
    });
  }

  async clearConversationMessages(conversationId, clearedAt, transactionClient = null) {
    if (!this.enabled) return;
    return this.withOptionalTransaction(transactionClient, async client => {
      await client.query('UPDATE conversations SET cleared_at=$2, updated_at=$2 WHERE conversation_id=$1', [conversationId, clearedAt]);
      await client.query('DELETE FROM encrypted_messages WHERE conversation_id=$1', [conversationId]);
    });
  }

  async deleteEncryptedMessage(conversationId, messageId, deletionSequence, deletedAt, expiresAt, transactionClient = null) {
    if (!this.enabled) return;
    return this.withOptionalTransaction(transactionClient, async client => {
      const allocated = await client.query(`UPDATE conversations SET
        next_deletion_sequence=next_deletion_sequence+1, updated_at=$2
        WHERE conversation_id=$1 AND status='active'
        RETURNING next_deletion_sequence-1 AS sequence`, [conversationId, deletedAt]);
      const sequence = allocated.rows.length ? Number(allocated.rows[0].sequence) : Number(deletionSequence);
      await client.query('DELETE FROM encrypted_messages WHERE conversation_id=$1 AND message_id=$2', [conversationId, messageId]);
      await client.query(`INSERT INTO deletion_tombstones (
        conversation_id, message_id, deletion_sequence, deleted_at, expires_at
      ) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (conversation_id,message_id) DO UPDATE SET
        deletion_sequence=GREATEST(deletion_tombstones.deletion_sequence,EXCLUDED.deletion_sequence),
        deleted_at=EXCLUDED.deleted_at, expires_at=EXCLUDED.expires_at`,
      [conversationId, messageId, sequence, deletedAt, expiresAt]);
      return sequence;
    });
  }

  async loadDeletionTombstones(conversationId, now = Date.now(), client = this.pool) {
    if (!this.enabled) return [];
    const { rows } = await client.query(`SELECT message_id,deletion_sequence,deleted_at
      FROM deletion_tombstones WHERE conversation_id=$1 AND expires_at>$2
      ORDER BY deletion_sequence`, [conversationId, now]);
    return rows.map(row => ({
      id:row.message_id, type:'message', content:null, deleted:true,
      deletionSeq:Number(row.deletion_sequence), ts:Number(row.deleted_at),
    }));
  }

  async close() { if (this.pool?.end) await this.pool.end(); }
}

module.exports = { PostgresStore, SCHEMA_SQL };
