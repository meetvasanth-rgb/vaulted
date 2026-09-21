'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const RETENTION = 90 * 86400000;
const SLA = 86400000;
const SCHEMA = `CREATE TABLE IF NOT EXISTS safety_reports (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS safety_blocks (blocker text NOT NULL, blocked text NOT NULL, created_at bigint NOT NULL, PRIMARY KEY(blocker,blocked));
CREATE TABLE IF NOT EXISTS safety_suspensions (account_id text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS safety_revoked_room_members (account_id text NOT NULL, room_code text NOT NULL, token_hash char(64) NOT NULL, PRIMARY KEY(room_code, token_hash));
CREATE INDEX IF NOT EXISTS safety_revoked_room_members_account_idx ON safety_revoked_room_members(account_id);
CREATE TABLE IF NOT EXISTS safety_migrations (id text PRIMARY KEY);`;
class SafetyStore {
  constructor(directory, pool = null) { this.directory=directory; this.pool=pool; this.reports=new Map(); this.blocks=new Map(); this.suspensions=new Set(); this.revokedRoomMembers=new Map(); this.suspensionLookups=new Map(); this.revocationLookups=new Map(); }
  async cachedRestrictionLookup(cache,key,query) {
    const now=Date.now();
    const cached=cache.get(key);
    if(cached && cached.expiresAt>now) return cached.promise;
    const promise=Promise.resolve().then(query);
    cache.set(key,{promise,expiresAt:now+5000});
    // Bound memory even if a client sends many distinct credentials.
    if(cache.size>5000) cache.delete(cache.keys().next().value);
    try {return await promise;}
    catch(error) {if(cache.get(key)?.promise===promise) cache.delete(key);throw error;}
  }
  invalidateAccountRestrictionCache(accountId) { this.suspensionLookups.delete(accountId); }
  invalidateRoomRestrictionCache(members) {
    for(const member of members) this.revocationLookups.delete(`${member.roomCode}:${member.tokenHash}`);
  }
  async initialize() {
    const file=path.join(this.directory,'safety-workflow.json');
    const legacy=path.join(this.directory,'safety-reports.jsonl');
    const fileText=fs.existsSync(file)?fs.readFileSync(file,'utf8'):null;
    const legacyText=fs.existsSync(legacy)?fs.readFileSync(legacy,'utf8'):null;
    let databaseMigrated=false;
    if(this.pool) {
      await this.pool.query(SCHEMA);
      databaseMigrated=!!(await this.pool.query("SELECT 1 FROM safety_migrations WHERE id='legacy-v1'")).rowCount;
      if(databaseMigrated && fileText===null && legacyText===null) return;
    }
    const data=fileText===null?{}:JSON.parse(fileText);
    const legacyReports=legacyText===null?[]:legacyText.split('\n').filter(Boolean).map(line=>JSON.parse(line));
    this.suspensions=new Set(data.suspensions || []);
    for(const entry of data.revokedRoomMembers || []) this.revokedRoomMembers.set(`${entry.roomCode}:${entry.tokenHash}`,entry);
    for(const r of data.reports || []) this.reports.set(r.id,r);
    for(const b of data.blocks || []) this.blocks.set(`${b.blocker}:${b.blocked}`,b);
    if(!data.legacyMigrated && !databaseMigrated) for(const r of legacyReports) {
      if(!this.reports.has(r.id)) this.reports.set(r.id,{...r,status:'open',updatedAt:r.createdAt,history:[]});
    }
    if(this.pool && !databaseMigrated) {
      for(const r of this.reports.values()) await this.pool.query('INSERT INTO safety_reports(id,data) VALUES($1,$2) ON CONFLICT DO NOTHING',[r.id,r]);
      for(const b of this.blocks.values()) await this.pool.query('INSERT INTO safety_blocks VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[b.blocker,b.blocked,b.createdAt]);
      for(const id of this.suspensions) await this.pool.query('INSERT INTO safety_suspensions VALUES($1) ON CONFLICT DO NOTHING',[id]);
      for(const entry of this.revokedRoomMembers.values()) await this.pool.query('INSERT INTO safety_revoked_room_members VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[entry.accountId,entry.roomCode,entry.tokenHash]);
    } else if(!this.pool) this.flush();

    // Read back durable copies before removing any source file. A conflict,
    // malformed input, failed write or changed source preserves the originals.
    const copied=this.pool?null:JSON.parse(fs.readFileSync(file,'utf8'));
    const sourceReports=this.pool?[...(data.reports || []),...legacyReports]:legacyReports;
    for(const original of sourceReports) {
      if(typeof original.id!=='string' || !original.id) throw Error('Legacy report has no valid ID; source retained.');
      const saved=this.pool?(await this.pool.query('SELECT data FROM safety_reports WHERE id=$1',[original.id])).rows[0]?.data:copied.reports.find(r=>r.id===original.id);
      // Review state may have legitimately advanced after a previous import.
      const evidence=r=>Object.fromEntries(Object.entries(r).filter(([key])=>!['status','updatedAt','history','dueAt','overdue'].includes(key)));
      if(!saved || !isDeepStrictEqual(evidence(original),Object.fromEntries(Object.keys(evidence(original)).map(key=>[key,saved[key]])))) throw Error('Legacy report copy verification failed; source retained.');
    }
    if(this.pool) {
      for(const b of data.blocks || []) if(!(await this.pool.query('SELECT 1 FROM safety_blocks WHERE blocker=$1 AND blocked=$2',[b.blocker,b.blocked])).rowCount) throw Error('Block copy verification failed; source retained.');
      for(const id of data.suspensions || []) if(!(await this.isSuspended(id))) throw Error('Restriction copy verification failed; source retained.');
      await this.pool.query("INSERT INTO safety_migrations VALUES('legacy-v1') ON CONFLICT DO NOTHING");
    }
    const removeVerifiedSource=(source,expected)=>{
      if(expected===null) return;
      if(fs.readFileSync(source,'utf8')!==expected) throw Error('Legacy source changed during migration; source retained.');
      fs.unlinkSync(source);
    };
    removeVerifiedSource(legacy,legacyText);
    if(this.pool) {
      removeVerifiedSource(file,fileText);
      this.reports.clear(); this.blocks.clear(); this.suspensions.clear();
    }
    console.log(`Safety migration verified: ${sourceReports.length} source reports; duplicate sources cleaned.`);
  }
  flush() {
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
    const file=path.join(this.directory,'safety-workflow.json'), temp=file+'.tmp';
    fs.writeFileSync(temp,JSON.stringify({legacyMigrated:true,suspensions:[...this.suspensions],revokedRoomMembers:[...this.revokedRoomMembers.values()],reports:[...this.reports.values()],blocks:[...this.blocks.values()]}),{mode:0o600});
    fs.renameSync(temp,file); fs.chmodSync(file,0o600);
  }
  async add(data) {
    const now=new Date().toISOString();
    const report={...data,id:crypto.randomUUID(),createdAt:now,updatedAt:now,status:'open',history:[]};
    if(this.pool) await this.pool.query('INSERT INTO safety_reports VALUES($1,$2)',[report.id,report]);
    else { this.reports.set(report.id,report); try {this.flush();} catch(e) {this.reports.delete(report.id);throw e;} }
    return report;
  }
  async get(id) {
    if (typeof id !== 'string' || !id) return null;
    return this.pool
      ? (await this.pool.query('SELECT data FROM safety_reports WHERE id=$1',[id])).rows[0]?.data || null
      : this.reports.get(id) || null;
  }
  async prune() {
    const cutoff=Date.now()-RETENTION;
    if(this.pool) await this.pool.query("DELETE FROM safety_reports WHERE data->>'status' IN ('resolved','dismissed') AND (data->>'updatedAt')::timestamptz < $1::timestamptz",[new Date(cutoff).toISOString()]);
    else { for(const [id,r] of this.reports) if(['resolved','dismissed'].includes(r.status)&&Date.parse(r.updatedAt)<cutoff) this.reports.delete(id); this.flush(); }
  }
  async list() {
    await this.prune();
    const reports=this.pool?(await this.pool.query('SELECT data FROM safety_reports ORDER BY CASE WHEN data->>\'status\' IN (\'resolved\',\'dismissed\') THEN 1 ELSE 0 END, data->>\'createdAt\' ASC')).rows.map(r=>r.data):[...this.reports.values()];
    return reports.sort((a,b)=>(['resolved','dismissed'].includes(a.status)-['resolved','dismissed'].includes(b.status)) || Date.parse(a.createdAt)-Date.parse(b.createdAt)).map(r=>({...r,dueAt:new Date(Date.parse(r.createdAt)+SLA).toISOString(),overdue:!['resolved','dismissed'].includes(r.status)&&Date.now()-Date.parse(r.createdAt)>SLA}));
  }
  async review(id,status,note,expectedUpdatedAt,operation) {
    // Serialize local reviews; PostgreSQL locks the report row across replicas.
    if (!this.pool) {
      const work = (this.reviewChain || Promise.resolve()).then(() => this.reviewLocked(id,status,note,expectedUpdatedAt,operation));
      this.reviewChain = work.catch(() => {});
      return work;
    }
    return this.reviewLocked(id,status,note,expectedUpdatedAt,operation);
  }
  async reviewLocked(id,status,note,expectedUpdatedAt,operation) {
    if(!['reviewing','resolved','dismissed'].includes(status)||typeof note!=='string'||!note.trim()||note.length>1000) throw Error('A valid status and a review note (1–1000 characters) are required.');
    const client = this.pool ? await this.pool.connect() : null;
    try {
      if(client) await client.query('BEGIN');
      const current=client?(await client.query('SELECT data FROM safety_reports WHERE id=$1 FOR UPDATE',[id])).rows[0]?.data:this.reports.get(id);
      if(!current) throw Error('Report not found.');
      if(current.updatedAt!==expectedUpdatedAt) throw Error('Report changed. Refresh before reviewing.');
      const updatedAt=new Date(Math.max(Date.now(),Date.parse(current.updatedAt)+1)).toISOString();
      const next={...current,status,updatedAt,history:[...(current.history||[]),{status,note:note.trim(),at:updatedAt}].slice(-50)};
      if(operation) await operation(current,client);
      if(client) {
        await client.query('UPDATE safety_reports SET data=$2 WHERE id=$1',[id,next]);
        await client.query('COMMIT');
      } else {this.reports.set(id,next);try {this.flush();}catch(e){this.reports.set(id,current);throw e;}}
      return next;
    } catch(error) {
      if(client) await client.query('ROLLBACK').catch(()=>{});
      throw error;
    } finally {if(client) client.release();}
  }
  async block(blocker,blocked) {
    if(!blocker||!blocked||blocker===blocked) throw Error('Invalid block.');
    const b={blocker,blocked,createdAt:Date.now()}, key=`${blocker}:${blocked}`, previous=this.blocks.get(key);
    if(this.pool) await this.pool.query('INSERT INTO safety_blocks VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[blocker,blocked,b.createdAt]);
    else {this.blocks.set(key,b);try{this.flush();}catch(e){if(previous)this.blocks.set(key,previous);else this.blocks.delete(key);throw e;}}
  }
  async setSuspended(accountId,suspended,client=null) {
    if(this.pool) await (client || this.pool).query(suspended ? 'INSERT INTO safety_suspensions VALUES($1) ON CONFLICT DO NOTHING' : 'DELETE FROM safety_suspensions WHERE account_id=$1',[accountId]);
    else {const had=this.suspensions.has(accountId);if(suspended)this.suspensions.add(accountId);else this.suspensions.delete(accountId);try{this.flush();}catch(error){if(had)this.suspensions.add(accountId);else this.suspensions.delete(accountId);throw error;}}
    if(!client) this.invalidateAccountRestrictionCache(accountId);
  }
  async isSuspended(accountId) {
    if(this.pool) return this.cachedRestrictionLookup(this.suspensionLookups,accountId,
      async () => !!(await this.pool.query('SELECT 1 FROM safety_suspensions WHERE account_id=$1',[accountId])).rowCount);
    return this.suspensions.has(accountId);
  }
  async listSuspended() {
    if(this.pool) return (await this.pool.query('SELECT account_id FROM safety_suspensions')).rows.map(row=>row.account_id);
    return [...this.suspensions];
  }
  async revokeRoomMembers(accountId, members, client=null) {
    if(this.pool) {
      const db=client || this.pool;
      for(const member of members) await db.query('INSERT INTO safety_revoked_room_members VALUES($1,$2,$3) ON CONFLICT (room_code,token_hash) DO UPDATE SET account_id=EXCLUDED.account_id',
        [accountId,member.roomCode,member.tokenHash]);
    } else {
      for(const member of members) this.revokedRoomMembers.set(`${member.roomCode}:${member.tokenHash}`,{accountId,...member});
      this.flush();
    }
    if(!client) this.invalidateRoomRestrictionCache(members);
  }
  async restoreRoomMembers(accountId, client=null) {
    if(this.pool) await (client || this.pool).query('DELETE FROM safety_revoked_room_members WHERE account_id=$1',[accountId]);
    else {
      for(const [key,entry] of this.revokedRoomMembers) if(entry.accountId===accountId) this.revokedRoomMembers.delete(key);
      this.flush();
    }
    if(!client) this.revocationLookups.clear();
  }
  async isRevokedRoomMember(roomCode, tokenHash) {
    if(this.pool) return this.cachedRestrictionLookup(this.revocationLookups,`${roomCode}:${tokenHash}`,
      async () => !!(await this.pool.query('SELECT 1 FROM safety_revoked_room_members WHERE room_code=$1 AND token_hash=$2',[roomCode,tokenHash])).rowCount);
    return this.revokedRoomMembers.has(`${roomCode}:${tokenHash}`);
  }
  async blocked(a,b) {
    if(this.pool) return !!(await this.pool.query('SELECT 1 FROM safety_blocks WHERE (blocker=$1 AND blocked=$2) OR (blocker=$2 AND blocked=$1) LIMIT 1',[a,b])).rowCount;
    return this.blocks.has(`${a}:${b}`)||this.blocks.has(`${b}:${a}`);
  }
}
module.exports={SafetyStore,SLA};
