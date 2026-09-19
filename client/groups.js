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

const MAX_PRIVATE_GROUP_ATTACHMENT_BYTES = 19 * 1024 * 1024;
let privateGroupVoiceRecorder = null;
let privateGroupVoiceStream = null;
let privateGroupVoiceChunks = [];
let privateGroupVoiceStartedAt = 0;

function updatePrivateGroupComposer() {
  const footer = document.getElementById('group-chat-footer');
  const input = document.getElementById('group-message-input');
  footer?.classList.toggle('has-text', !!String(input?.value || '').trim());
}

function showPrivateGroupAttachOptions() {
  closePrivateGroupAttachOptions();
  const button = document.getElementById('group-attach-btn');
  if (!button || !activePrivateGroupId) return;
  const rect = button.getBoundingClientRect();
  const popover = document.createElement('div');
  popover.id = 'group-attach-popover'; popover.className = 'attach-popover';
  popover.style.bottom = `${window.innerHeight - rect.top + 8}px`;
  popover.style.left = `${Math.max(8, rect.left - 4)}px`;
  popover.innerHTML = `
    <button type="button" class="attach-opt" data-input="group-camera-input"><span class="attach-opt-icon">📷</span><span class="attach-opt-label">Camera</span></button>
    <button type="button" class="attach-opt" data-input="group-image-input"><span class="attach-opt-icon">▧</span><span class="attach-opt-label">Gallery</span></button>
    <button type="button" class="attach-opt" data-input="group-file-input"><span class="attach-opt-icon">⌑</span><span class="attach-opt-label">File</span></button>
    <button type="button" class="attach-opt" id="group-attach-gif"><span class="attach-opt-icon" style="font-weight:800;font-size:12px;color:#682C43">GIF</span><span class="attach-opt-label">GIF</span></button>`;
  document.body.appendChild(popover);
  for (const option of popover.querySelectorAll('[data-input]')) option.onclick = event => {
    event.stopPropagation(); const id = option.dataset.input; closePrivateGroupAttachOptions(); document.getElementById(id)?.click();
  };
  popover.querySelector('#group-attach-gif').onclick = event => {
    event.stopPropagation(); closePrivateGroupAttachOptions(); openKlipyPicker('group');
  };
  setTimeout(() => document.addEventListener('click', privateGroupAttachOutsideClick), 0);
}

function closePrivateGroupAttachOptions() {
  document.getElementById('group-attach-popover')?.remove();
  document.removeEventListener('click', privateGroupAttachOutsideClick);
}

function privateGroupAttachOutsideClick(event) {
  const popover = document.getElementById('group-attach-popover');
  if (popover && !popover.contains(event.target) && !event.target.closest('#group-attach-btn')) closePrivateGroupAttachOptions();
}

async function uploadPrivateGroupAttachment(state, group, messageId, ciphertext) {
  const size = new Blob([ciphertext]).size;
  if (size < 1 || size > MAX_PRIVATE_GROUP_ATTACHMENT_BYTES) throw new Error('Attachment is too large');
  const prepared = await api('/api/groups/attachment/prepare', { accountId:state.accountId, sessionToken:state.sessionToken,
    groupId:group.id, messageId, size });
  if (!prepared?.attachmentId || !prepared?.uploadUrl) throw new Error(prepared?.error || 'Could not prepare attachment');
  const url = new URL(prepared.uploadUrl, location.href);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new Error('Unsafe attachment address');
  const response = await fetch(url.href, { method:'PUT', headers:{ 'Content-Type':prepared.contentType || 'application/octet-stream' }, body:ciphertext });
  if (!response.ok) throw new Error('Could not upload attachment');
  return prepared.attachmentId;
}

async function downloadPrivateGroupAttachment(state, group, attachmentId) {
  const prepared = await api('/api/groups/attachment/download', { accountId:state.accountId, sessionToken:state.sessionToken,
    groupId:group.id, attachmentId });
  if (!prepared?.downloadUrl) throw new Error(prepared?.error || 'Could not open attachment');
  const url = new URL(prepared.downloadUrl, location.href);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new Error('Unsafe attachment address');
  const response = await fetch(url.href, { cache:'no-store' });
  if (!response.ok) throw new Error('Could not open attachment');
  const ciphertext = await response.text();
  if (!ciphertext || new Blob([ciphertext]).size > MAX_PRIVATE_GROUP_ATTACHMENT_BYTES) throw new Error('Invalid attachment');
  return ciphertext;
}

async function sendPrivateGroupAttachment(payload) {
  const state = loadAccountState(); const group = privateGroups.get(activePrivateGroupId);
  const key = group?.keys?.[group?.keyVersion];
  if (!state || !group || !key) throw new Error('Group encryption key is not ready');
  const messageId = newMsgId();
  const encryptedPayload = await encryptPrivateGroupValue(key, payload);
  const attachmentId = await uploadPrivateGroupAttachment(state, group, messageId, encryptedPayload);
  const ciphertext = await encryptPrivateGroupValue(key, { type:'group-attachment', attachmentId });
  const result = await api('/api/groups/send', { accountId:state.accountId, sessionToken:state.sessionToken,
    groupId:group.id, messageId, ciphertext, attachmentId });
  if (result.error) throw new Error(result.error);
  group.messages = [...(group.messages || []), { id:messageId, senderId:state.accountId, attachmentId,
    attachment:payload, createdAt:result.createdAt, keyVersion:result.keyVersion }];
  group.updatedAt = result.createdAt; renderPrivateGroupMessages(group); renderVaultList();
}

async function sendPrivateGroupGif(item, searchQuery) {
  const url = safeKlipyMediaUrl(item?.url); if (!url) return false;
  const state = loadAccountState(); const group = privateGroups.get(activePrivateGroupId);
  const key = group?.keys?.[group?.keyVersion]; if (!state || !group || !key) return false;
  const messageId = newMsgId();
  const payload = { type:'group-gif', id:String(item.id || ''), title:String(item.title || 'GIF').slice(0,200), url };
  const ciphertext = await encryptPrivateGroupValue(key, payload);
  const result = await api('/api/groups/send', { accountId:state.accountId, sessionToken:state.sessionToken,
    groupId:group.id, messageId, ciphertext });
  if (result.error) throw new Error(result.error);
  group.messages = [...(group.messages || []), { id:messageId, senderId:state.accountId, gif:payload,
    createdAt:result.createdAt, keyVersion:result.keyVersion }];
  group.updatedAt = result.createdAt; renderPrivateGroupMessages(group); renderVaultList(); closeKlipyPicker();
  const [locale, country] = klipyLocale();
  fetch(`https://api.klipy.com/v2/registershare?${new URLSearchParams({ key:KLIPY_API_KEY, id:payload.id, locale, country, q:searchQuery || '' })}`).catch(() => {});
  return true;
}

async function handlePrivateGroupFileSelect(event) {
  const files = Array.from(event.target.files || []); event.target.value = '';
  if (!files.length) return;
  for (const file of files) {
    try {
      if (file.size > 10 * 1024 * 1024) { toast(`“${file.name}” is too large — maximum 10MB`); continue; }
      let base64, mime = file.type || 'application/octet-stream';
      if (mime.startsWith('image/')) {
        toast('Preparing photo…');
        const compressed = await compressImageFile(file); base64 = compressed.base64; mime = compressed.mime;
        if (!await allowLocalImageSend([base64], message => toast(message), { persist:true })) continue;
      } else base64 = await fileToBase64(file);
      toast('Sending attachment…');
      await sendPrivateGroupAttachment({ type:mime.startsWith('image/') ? 'group-image' : 'group-file',
        name:String(file.name || 'Attachment').slice(0,180), mime, size:Math.ceil(base64.length * 3 / 4), data:base64 });
      toast(mime.startsWith('image/') ? 'Photo sent' : 'File sent');
    } catch (error) { toast(error.message || 'Attachment could not be sent'); }
  }
}

async function togglePrivateGroupVoiceRecording() {
  if (privateGroupVoiceRecorder?.state === 'recording') { privateGroupVoiceRecorder.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { toast('Voice recording is not available on this device'); return; }
  try {
    privateGroupVoiceStream = await navigator.mediaDevices.getUserMedia({ audio:true });
    privateGroupVoiceChunks = []; privateGroupVoiceStartedAt = Date.now();
    privateGroupVoiceRecorder = new MediaRecorder(privateGroupVoiceStream);
    privateGroupVoiceRecorder.ondataavailable = event => { if (event.data?.size) privateGroupVoiceChunks.push(event.data); };
    privateGroupVoiceRecorder.onstop = async () => {
      const duration = Math.max(1, Math.round((Date.now() - privateGroupVoiceStartedAt) / 1000));
      const mime = privateGroupVoiceRecorder?.mimeType || privateGroupVoiceChunks[0]?.type || 'audio/webm';
      const blob = new Blob(privateGroupVoiceChunks, { type:mime });
      privateGroupVoiceStream?.getTracks().forEach(track => track.stop()); privateGroupVoiceStream = null;
      document.querySelector('.group-mic-btn')?.classList.remove('recording');
      try {
        if (blob.size > 10 * 1024 * 1024) throw new Error('Voice note is too large — record a shorter note');
        toast('Sending voice note…');
        await sendPrivateGroupAttachment({ type:'group-voice', name:'Voice note', mime, duration, size:blob.size, data:await blobToBase64(blob) });
        toast('Voice note sent');
      } catch (error) { toast(error.message || 'Voice note could not be sent'); }
    };
    privateGroupVoiceRecorder.start(); document.querySelector('.group-mic-btn')?.classList.add('recording');
    toast('Recording voice note — tap the microphone again to send');
    setTimeout(() => { if (privateGroupVoiceRecorder?.state === 'recording') privateGroupVoiceRecorder.stop(); }, 5 * 60 * 1000);
  } catch (error) { toast('Microphone permission is required for voice notes'); }
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
  const input = document.getElementById('group-message-input');
  if (input) input.value = '';
  updatePrivateGroupComposer();
  document.getElementById('group-chat-title').textContent = group.name || 'Private group';
  document.getElementById('group-chat-sub').textContent = `${group.members?.length || 1} members · end-to-end encrypted`;
  document.getElementById('group-chat').classList.add('open');
  document.getElementById('group-chat').setAttribute('aria-hidden','false');
  renderPrivateGroupMessages(group); await pollPrivateGroup(true);
  clearInterval(groupPollTimer); groupPollTimer = setInterval(() => pollPrivateGroup(false), 3000);
}

function closePrivateGroup() {
  clearInterval(groupPollTimer); groupPollTimer = null;
  closePrivateGroupAttachOptions();
  if (privateGroupVoiceRecorder?.state === 'recording') {
    privateGroupVoiceRecorder.onstop = null; privateGroupVoiceRecorder.stop();
    privateGroupVoiceStream?.getTracks().forEach(track => track.stop()); privateGroupVoiceStream = null;
  }
  activePrivateGroupId = null;
  document.getElementById('group-chat')?.classList.remove('open');
  document.getElementById('group-chat')?.setAttribute('aria-hidden','true'); renderVaultList();
}

function renderPrivateGroupMessages(group) {
  const body = document.getElementById('group-chat-body'); if (!body) return;
  const state = loadAccountState();
  if (!group.messages?.length) { body.innerHTML = '<div class="group-chat-empty">This private group is ready.<br>Send the first encrypted message.</div>'; return; }
  body.innerHTML = group.messages.map(message => {
    let content;
    if (message.attachment?.type === 'group-image') {
      const mime = /^image\/(jpeg|png|webp|gif)$/i.test(message.attachment.mime) ? message.attachment.mime : 'image/jpeg';
      content = message.imageSafety && message.imageSafety !== 'allowed'
        ? '<div class="group-attachment-status">Photo hidden because the on-device safety check could not approve it.</div>'
        : `<button class="group-message-attachment" type="button" onclick="openPrivateGroupAttachment('${escHtml(message.id)}')"><img src="data:${mime};base64,${escHtml(message.attachment.data)}" alt="${escHtml(message.attachment.name || 'Group photo')}"></button>`;
    } else if (message.attachment?.type === 'group-voice') {
      const mime = /^audio\/[a-z0-9.+-]+(?:;codecs=[a-z0-9.+-]+)?$/i.test(message.attachment.mime) ? message.attachment.mime : 'audio/webm';
      content = `<audio class="group-message-attachment" controls preload="metadata" src="data:${mime};base64,${escHtml(message.attachment.data)}"></audio>`;
    } else if (message.attachment?.type === 'group-file') {
      content = `<button class="group-file-card" type="button" onclick="openPrivateGroupAttachment('${escHtml(message.id)}')">⌑ <span>${escHtml(message.attachment.name || 'Attachment')}</span></button>`;
    } else if (message.gif?.type === 'group-gif' && safeKlipyMediaUrl(message.gif.url)) {
      content = `<div class="group-message-attachment"><img src="${escHtml(message.gif.url)}" alt="${escHtml(message.gif.title || 'GIF')}" loading="lazy"></div>`;
    } else {
      const unsafe = message.senderId !== state?.accountId && (!window.VaultlixContentSafety || window.VaultlixContentSafety.check(message.text).blocked);
      const visibleText = unsafe ? 'Potentially harmful message hidden. Use the member menu to remove this person.' : message.text;
      content = `<div class="group-message-text">${escHtml(visibleText)}</div>`;
    }
    return `<div class="group-message${message.senderId === state?.accountId ? ' mine' : ''}"><div class="group-message-name">${escHtml(groupMemberLabel(group, message.senderId))}</div>${content}<div class="group-message-time">${escHtml(new Date(message.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}))}</div></div>`;
  }).join('');
  body.scrollTop = body.scrollHeight;
}

function openPrivateGroupAttachment(messageId) {
  const group = privateGroups.get(activePrivateGroupId);
  const attachment = group?.messages?.find(message => message.id === messageId)?.attachment;
  if (!attachment?.data) return;
  const mime = /^[a-z]+\/[a-z0-9.+-]+(?:;codecs=[a-z0-9.+-]+)?$/i.test(attachment.mime) ? attachment.mime : 'application/octet-stream';
  transferDataUri(`data:${mime};base64,${attachment.data}`, attachment.name || 'Vaultlix attachment');
}

async function decodePrivateGroupMessage(group, state, message) {
  const plaintext = await decryptPrivateGroupValue(group.keys?.[message.keyVersion], message.ciphertext);
  let metadata = null;
  try { metadata = JSON.parse(plaintext); } catch (_) {}
  if (metadata?.type === 'group-gif' && safeKlipyMediaUrl(metadata.url)) return { ...message, gif:metadata };
  if (metadata?.type !== 'group-attachment' || !metadata.attachmentId) return { ...message, text:plaintext };
  const encryptedPayload = await downloadPrivateGroupAttachment(state, group, metadata.attachmentId);
  const payload = JSON.parse(await decryptPrivateGroupValue(group.keys?.[message.keyVersion], encryptedPayload));
  if (!['group-image','group-file','group-voice'].includes(payload?.type) || typeof payload.data !== 'string' || payload.data.length > 26 * 1024 * 1024) {
    throw new Error('Invalid group attachment');
  }
  const decoded = { ...message, attachmentId:metadata.attachmentId, attachment:payload };
  if (payload.type === 'group-image' && message.senderId !== state.accountId && localImageSafetyEnabled()) {
    decoded.imageSafety = await checkLocalImages([payload.data], undefined, { persist:true });
  }
  return decoded;
}

async function pollPrivateGroup(render = false) {
  const state = loadAccountState(); const group = privateGroups.get(activePrivateGroupId);
  if (!state || !group) return;
  const result = await api('/api/groups/messages', { accountId:state.accountId, sessionToken:state.sessionToken, groupId:group.id, after:group.messageCursor || 0 });
  if (result.error) return;
  const decoded = [];
  for (const message of result.messages || []) {
    try { decoded.push(await decodePrivateGroupMessage(group, state, message)); }
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
    input.value = ''; updatePrivateGroupComposer(); group.messages = [...(group.messages || []), { id:messageId, senderId:state.accountId, text, createdAt:result.createdAt, keyVersion:result.keyVersion }];
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
