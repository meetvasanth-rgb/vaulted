'use strict';

async function importPrivateGroupKey(encoded) {
  return crypto.subtle.importKey('raw', base64UrlToBytes(encoded), { name:'AES-GCM' }, false, ['encrypt','decrypt']);
}

async function encryptPrivateGroupValue(encodedKey, value) {
  const key = await importPrivateGroupKey(encodedKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, plain));
  const packed = new Uint8Array(iv.length + encrypted.length);
  packed.set(iv); packed.set(encrypted, iv.length);
  return `g1:${bytesToBase64(packed)}`;
}

async function decryptPrivateGroupValue(encodedKey, value) {
  if (!encodedKey || typeof value !== 'string' || !value.startsWith('g1:')) throw new Error('GROUP_KEY');
  const raw = Uint8Array.from(atob(value.slice(3)), character => character.charCodeAt(0));
  const key = await importPrivateGroupKey(encodedKey);
  const plain = await crypto.subtle.decrypt({ name:'AES-GCM', iv:raw.slice(0,12) }, key, raw.slice(12));
  return new TextDecoder().decode(plain);
}

function groupMemberLabel(group, accountId) {
  const member = group?.members?.find(candidate => candidate.accountId === accountId);
  return member?.displayName || (accountId === loadAccountState()?.accountId ? 'You' : 'Member');
}

async function unwrapPrivateGroupKeys(serverGroup, local) {
  const keys = { ...(local?.keys || {}) };
  const room = rooms.get(serverGroup.wrapRoomCode);
  if (!room?.sharedKey) return keys;
  const wrapped = serverGroup.wrappedKeys || (serverGroup.wrappedKey ? { [serverGroup.keyVersion]:serverGroup.wrappedKey } : {});
  for (const [version, envelope] of Object.entries(wrapped)) {
    if (keys[version]) continue;
    try {
      const payload = JSON.parse(await decryptMsg(room, envelope));
      if (payload.type === 'private-group-key' && payload.groupKeyId === serverGroup.keyBinding && Number(payload.version) === Number(version)) keys[version] = payload.key;
    } catch (_) { console.warn('Private group key could not be opened', serverGroup.id, version); }
  }
  return keys;
}

async function refreshPrivateGroups() {
  const state = loadAccountState();
  if (!state) return;
  const result = await api('/api/groups/list', { accountId:state.accountId, sessionToken:state.sessionToken });
  if (result.error) return;
  const stored = new Map(loadPrivateGroupSessions().map(group => [group.id, group]));
  const live = new Set();
  let receivedNewKey = false;
  for (const serverGroup of result.groups || []) {
    live.add(serverGroup.id);
    const local = privateGroups.get(serverGroup.id) || stored.get(serverGroup.id) || null;
    const keys = await unwrapPrivateGroupKeys(serverGroup, local);
    if (Object.keys(keys).length > Object.keys(local?.keys || {}).length) receivedNewKey = true;
    let name = local?.name || 'Private group';
    if (keys[serverGroup.keyVersion]) {
      try { name = await decryptPrivateGroupValue(keys[serverGroup.keyVersion], serverGroup.encryptedName); } catch (_) {}
    }
    privateGroups.set(serverGroup.id, { ...local, ...serverGroup, name, keys,
      ownerAccountId:state.accountId, messages:local?.messages || [], unread:local?.unread || 0 });
  }
  for (const id of [...privateGroups.keys()]) if (!live.has(id)) privateGroups.delete(id);
  savePrivateGroupSessions();
  if (receivedNewKey) scheduleAccountSync();
  if (document.getElementById('s-vault-list')?.classList.contains('active')) renderVaultList();
  if (activePrivateGroupId && privateGroups.has(activePrivateGroupId)) await pollPrivateGroup(true);
  for (const group of privateGroups.values()) {
    if (group.ownerId === state.accountId && group.requiresRekey) rotatePrivateGroupKey(group).catch(error => console.error('Group rekey failed', error));
  }
}

function openCreateGroup() {
  const state = loadAccountState();
  if (!state) { openAccountPanel(); showAccountTab('login'); return; }
  const eligible = [...rooms.values()].filter(room => room.sharedKey && room.peerPrivateNumber && room.ownerAccountId === state.accountId && !room.reconnectRequired);
  document.getElementById('group-contact-list').innerHTML = eligible.length
    ? eligible.map(room => `<label class="group-contact"><input type="checkbox" value="${escHtml(room.code)}"><span>${escHtml(roomDisplayLabel(room))}<small>${escHtml(formatPrivateNumber(room.peerPrivateNumber))}</small></span></label>`).join('')
    : '<div class="group-chat-empty" style="padding:24px">Connect with a friend before creating a group.</div>';
  document.getElementById('group-name-input').value = '';
  document.getElementById('group-create-overlay').classList.add('open');
  setTimeout(() => document.getElementById('group-name-input')?.focus(), 50);
}

function closeCreateGroup() { document.getElementById('group-create-overlay')?.classList.remove('open'); }

async function createPrivateGroup() {
  const state = loadAccountState();
  const name = String(document.getElementById('group-name-input')?.value || '').trim().replace(/\s+/g, ' ');
  const selectedCodes = [...document.querySelectorAll('#group-contact-list input:checked')].map(input => input.value);
  if (!state || name.length < 2 || name.length > 40) { toast('Enter a group name between 2 and 40 characters'); return; }
  if (!selectedCodes.length) { toast('Select at least one contact'); return; }
  const button = document.getElementById('group-create-submit');
  button.disabled = true; button.textContent = 'Creating…';
  try {
    const encodedKey = bytesToBase64UrlCompact(crypto.getRandomValues(new Uint8Array(32)));
    const encryptedName = await encryptPrivateGroupValue(encodedKey, name);
    const groupKeyId = bytesToBase64UrlCompact(crypto.getRandomValues(new Uint8Array(18)));
    const groupId = crypto.randomUUID();
    const members = [];
    for (const code of selectedCodes) {
      const room = rooms.get(code);
      if (!room?.sharedKey) throw new Error('One contact is not securely connected yet');
      const wrappedKey = await encryptMsg(room, JSON.stringify({ type:'private-group-key', groupKeyId, version:1, key:encodedKey }));
      members.push({ roomCode:code, wrappedKey });
    }
    const result = await api('/api/groups/create', { accountId:state.accountId, sessionToken:state.sessionToken,
      groupId, encryptedName, members, keyBinding:groupKeyId });
    if (result.error) throw new Error(result.error);
    privateGroups.set(result.group.id, { ...result.group, name, keys:{ 1:encodedKey }, ownerAccountId:state.accountId, messages:[], unread:0 });
    savePrivateGroupSessions(); scheduleAccountSync(); closeCreateGroup(); renderVaultList();
    toast('Private group created'); openPrivateGroup(result.group.id);
  } catch (error) { toast(error.message || 'Could not create the private group'); }
  finally { button.disabled = false; button.textContent = 'Create group'; }
}

async function openPrivateGroup(id) {
  const group = privateGroups.get(id); if (!group) return;
  activePrivateGroupId = id; group.unread = 0;
  document.getElementById('group-chat-title').textContent = group.name || 'Private group';
  document.getElementById('group-chat-sub').textContent = `${group.members?.length || 1} members · end-to-end encrypted`;
  document.getElementById('group-chat').classList.add('open');
  document.getElementById('group-chat').setAttribute('aria-hidden','false');
  renderPrivateGroupMessages(group); await pollPrivateGroup(true);
  clearInterval(groupPollTimer); groupPollTimer = setInterval(() => pollPrivateGroup(false), 3000);
}

function closePrivateGroup() {
  clearInterval(groupPollTimer); groupPollTimer = null; activePrivateGroupId = null;
  document.getElementById('group-chat')?.classList.remove('open');
  document.getElementById('group-chat')?.setAttribute('aria-hidden','true'); renderVaultList();
}

function renderPrivateGroupMessages(group) {
  const body = document.getElementById('group-chat-body'); if (!body) return;
  const state = loadAccountState();
  if (!group.messages?.length) { body.innerHTML = '<div class="group-chat-empty">This private group is ready.<br>Send the first encrypted message.</div>'; return; }
  body.innerHTML = group.messages.map(message => {
    const unsafe = message.senderId !== state?.accountId && (!window.VaultlixContentSafety || window.VaultlixContentSafety.check(message.text).blocked);
    const visibleText = unsafe ? 'Potentially harmful message hidden. Use the member menu to remove this person.' : message.text;
    return `<div class="group-message${message.senderId === state?.accountId ? ' mine' : ''}"><div class="group-message-name">${escHtml(groupMemberLabel(group, message.senderId))}</div><div class="group-message-text">${escHtml(visibleText)}</div><div class="group-message-time">${escHtml(new Date(message.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}))}</div></div>`;
  }).join('');
  body.scrollTop = body.scrollHeight;
}

async function pollPrivateGroup(render = false) {
  const state = loadAccountState(); const group = privateGroups.get(activePrivateGroupId);
  if (!state || !group) return;
  const result = await api('/api/groups/messages', { accountId:state.accountId, sessionToken:state.sessionToken, groupId:group.id, after:group.messageCursor || 0 });
  if (result.error) return;
  const decoded = [];
  for (const message of result.messages || []) {
    try { decoded.push({ ...message, text:await decryptPrivateGroupValue(group.keys?.[message.keyVersion], message.ciphertext) }); }
    catch (_) { decoded.push({ ...message, text:'Encrypted message unavailable on this device.' }); }
  }
  const known = new Set((group.messages || []).map(item => item.id));
  const incoming = decoded.filter(item => !known.has(item.id));
  const changed = incoming.length > 0;
  group.messages = [...(group.messages || []), ...incoming].sort((a,b) => a.createdAt - b.createdAt).slice(-200);
  group.messageCursor = Math.max(group.messageCursor || 0, Number(result.cursor) || 0);
  group.updatedAt = group.messages[group.messages.length - 1]?.createdAt || group.updatedAt;
  if (render || changed) renderPrivateGroupMessages(group);
}

async function sendPrivateGroupMessage() {
  const state = loadAccountState(); const group = privateGroups.get(activePrivateGroupId);
  const input = document.getElementById('group-message-input'); const text = String(input?.value || '').trim();
  if (!state || !group || !text) return;
  if (!window.VaultlixContentSafety) { toast('Safety checks could not load. Reopen Vaultlix before sending.'); return; }
  if (window.VaultlixContentSafety.check(text).blocked) { toast('This text cannot be shared. Edit it and try again.'); return; }
  const key = group.keys?.[group.keyVersion]; if (!key) { toast('Group encryption key is not ready'); return; }
  input.disabled = true;
  try {
    const messageId = newMsgId(); const ciphertext = await encryptPrivateGroupValue(key, text);
    const result = await api('/api/groups/send', { accountId:state.accountId, sessionToken:state.sessionToken, groupId:group.id, messageId, ciphertext });
    if (result.error) throw new Error(result.error);
    input.value = ''; group.messages = [...(group.messages || []), { id:messageId, senderId:state.accountId, text, createdAt:result.createdAt, keyVersion:result.keyVersion }];
    group.updatedAt = result.createdAt; renderPrivateGroupMessages(group); renderVaultList();
  } catch (error) { toast(error.message || 'Message could not be sent'); }
  finally { input.disabled = false; input.focus(); }
}

function openGroupMembers() {
  const group = privateGroups.get(activePrivateGroupId); const state = loadAccountState(); if (!group || !state) return;
  const owner = group.ownerId === state.accountId;
  document.getElementById('group-members-list').innerHTML = (group.members || []).map(member => `<div class="group-member"><span><strong>${escHtml(member.displayName || 'Vaultlix member')}${member.accountId === state.accountId ? ' · You' : ''}</strong><small>${escHtml(formatPrivateNumber(member.privateNumber))}${member.role === 'owner' ? ' · Owner' : ''}</small></span>${member.accountId !== state.accountId ? `<span>${owner ? `<button type="button" onclick="removePrivateGroupMember('${escHtml(member.accountId)}')">Remove</button>` : ''}<button type="button" onclick="reportPrivateGroupMember('${escHtml(member.accountId)}')">Report / block</button></span>` : ''}</div>`).join('');
  document.getElementById('group-members-actions').innerHTML = `${owner ? '<button class="danger" type="button" onclick="deletePrivateGroup()">Delete group</button>' : '<button class="danger" type="button" onclick="leavePrivateGroup()">Leave group</button>'}<button class="close" type="button" onclick="closeGroupMembers()">Close</button>`;
  document.getElementById('group-members').classList.add('open');
}

function closeGroupMembers() { document.getElementById('group-members')?.classList.remove('open'); }

async function rotatePrivateGroupKey(group, removedAccountId = null) {
  const state = loadAccountState(); if (!state || group.ownerId !== state.accountId) return false;
  const nextVersion = Number(group.keyVersion) + 1;
  const encodedKey = bytesToBase64UrlCompact(crypto.getRandomValues(new Uint8Array(32)));
  const encryptedName = await encryptPrivateGroupValue(encodedKey, group.name);
  const remaining = (group.members || []).filter(member => member.accountId !== state.accountId && member.accountId !== removedAccountId);
  const envelopes = [];
  for (const member of remaining) {
    const room = rooms.get(member.wrapRoomCode);
    if (!room?.sharedKey) throw new Error(`Open the secure conversation with ${member.displayName || 'a member'} before changing membership.`);
    const wrappedKey = await encryptMsg(room, JSON.stringify({ type:'private-group-key', groupKeyId:group.keyBinding, version:nextVersion, key:encodedKey }));
    envelopes.push({ accountId:member.accountId, wrapRoomCode:member.wrapRoomCode, wrappedKey });
  }
  const result = await api('/api/groups/rekey', { accountId:state.accountId, sessionToken:state.sessionToken,
    groupId:group.id, removedAccountId, encryptedName, envelopes });
  if (result.error) throw new Error(result.error);
  group.keys = { ...(group.keys || {}), [nextVersion]:encodedKey };
  group.keyVersion = nextVersion; group.requiresRekey = false; group.members = result.group.members; group.updatedAt = result.group.updatedAt;
  savePrivateGroupSessions(); scheduleAccountSync(); renderVaultList(); return true;
}

async function removePrivateGroupMember(accountId) {
  const group = privateGroups.get(activePrivateGroupId); if (!group || !confirm('Remove this member from the private group?')) return;
  try { await rotatePrivateGroupKey(group, accountId); closeGroupMembers(); openGroupMembers(); toast('Member removed and group key changed'); }
  catch (error) { toast(error.message || 'Member could not be removed'); }
}

async function reportPrivateGroupMember(accountId) {
  const state = loadAccountState(); const group = privateGroups.get(activePrivateGroupId);
  if (!state || !group) return;
  const reason = String(prompt('Reason: spam, harassment, threats, sexual, illegal, or other', 'harassment') || '').trim().toLowerCase();
  if (!['spam','harassment','threats','sexual','illegal','other'].includes(reason)) { toast('Choose one of the listed report reasons'); return; }
  const includeMessages = confirm('Include up to five recent readable messages from this member with the report? This shares those message contents with Vaultlix safety staff.');
  const messages = includeMessages ? (group.messages || []).filter(message => message.senderId === accountId).slice(-5).map(message => ({ content:message.text, ts:message.createdAt })) : [];
  const result = await api('/api/groups/report', { accountId:state.accountId, sessionToken:state.sessionToken,
    groupId:group.id, reportedAccountId:accountId, reason, messages });
  if (result.error) { toast(result.error); return; }
  try {
    if (group.ownerId === state.accountId) {
      await rotatePrivateGroupKey(group, accountId);
      closeGroupMembers(); openGroupMembers();
    } else {
      await api('/api/groups/leave', { accountId:state.accountId, sessionToken:state.sessionToken, groupId:group.id });
      privateGroups.delete(group.id); savePrivateGroupSessions(); scheduleAccountSync(); closeGroupMembers(); closePrivateGroup();
    }
  } catch (error) { console.error('Group safety exit failed', error); }
  toast('Report sent and member blocked');
}

async function leavePrivateGroup() {
  const state = loadAccountState(); const group = privateGroups.get(activePrivateGroupId);
  if (!state || !group || !confirm('Leave this private group?')) return;
  const result = await api('/api/groups/leave', { accountId:state.accountId, sessionToken:state.sessionToken, groupId:group.id });
  if (result.error) { toast(result.error); return; }
  privateGroups.delete(group.id); savePrivateGroupSessions(); scheduleAccountSync(); closeGroupMembers(); closePrivateGroup(); toast('You left the group');
}

async function deletePrivateGroup() {
  const state = loadAccountState(); const group = privateGroups.get(activePrivateGroupId);
  if (!state || !group || !confirm('Delete this private group for every member?')) return;
  const result = await api('/api/groups/delete', { accountId:state.accountId, sessionToken:state.sessionToken, groupId:group.id });
  if (result.error) { toast(result.error); return; }
  privateGroups.delete(group.id); savePrivateGroupSessions(); scheduleAccountSync(); closeGroupMembers(); closePrivateGroup(); toast('Private group deleted');
}
