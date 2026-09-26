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

const MAX_PRIVATE_GROUP_FILE_BYTES = 25 * 1024 * 1024;
const MAX_PRIVATE_GROUP_ATTACHMENT_BYTES = 48 * 1024 * 1024;
let privateGroupVoiceRecorder = null;
let privateGroupVoiceStream = null;
let privateGroupVoiceChunks = [];
let privateGroupVoiceStartedAt = 0;
let openingPrivateGroupId = null;
let privateGroupOpenRequestId = 0;
const PRIVATE_GROUP_PRELOAD_CONCURRENCY = 3;
const privateGroupPreloadTasks = new Map();
const privateGroupPreloadQueue = [];
let privateGroupPreloadActive = 0;

function pumpPrivateGroupPreloads() {
  while (privateGroupPreloadActive < PRIVATE_GROUP_PRELOAD_CONCURRENCY && privateGroupPreloadQueue.length) {
    const entry = privateGroupPreloadQueue.shift();
    if (!entry || privateGroupPreloadTasks.get(entry.id) !== entry) continue;
    privateGroupPreloadActive++;
    pollPrivateGroup(false, entry.id).then(entry.resolve, () => entry.resolve(false)).finally(() => {
      if (privateGroupPreloadTasks.get(entry.id) === entry) privateGroupPreloadTasks.delete(entry.id);
      privateGroupPreloadActive--;
      pumpPrivateGroupPreloads();
    });
  }
}

function preloadPrivateGroup(id, { priority = false } = {}) {
  const group = privateGroups.get(id);
  if (!group || !hasPrivateGroupKeys(group)) return Promise.resolve(false);
  const existing = privateGroupPreloadTasks.get(id);
  if (existing) {
    if (priority) {
      const index = privateGroupPreloadQueue.indexOf(existing);
      if (index > 0) {
        privateGroupPreloadQueue.splice(index, 1);
        privateGroupPreloadQueue.unshift(existing);
      }
    }
    return existing.promise;
  }
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  const entry = { id, promise, resolve };
  privateGroupPreloadTasks.set(id, entry);
  if (priority) privateGroupPreloadQueue.unshift(entry); else privateGroupPreloadQueue.push(entry);
  pumpPrivateGroupPreloads();
  return promise;
}

function preloadPrivateGroupsInBackground() {
  for (const group of privateGroups.values()) preloadPrivateGroup(group.id).catch(() => {});
}

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
    <button type="button" class="attach-opt" data-input="group-camera-input"><span class="attach-opt-icon"><svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.5l1.6-2.4c.2-.3.5-.6.9-.6h6c.4 0 .7.3.9.6L20.5 6H21a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="3.8"/></svg></span><span class="attach-opt-label">Camera</span></button>
    <button type="button" class="attach-opt" data-input="group-image-input"><span class="attach-opt-icon"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="1.7"/><path d="M21 15l-5.5-5.5a1.5 1.5 0 0 0-2.1 0L5 18"/></svg></span><span class="attach-opt-label">Gallery</span></button>
    <button type="button" class="attach-opt" data-input="group-file-input"><span class="attach-opt-icon"><svg viewBox="0 0 24 24"><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg></span><span class="attach-opt-label">File</span></button>
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

// Group attachments share the on-device download cache with one-to-one
// chats. The cache "room" is `group:<id>`, which can never collide with a
// conversation code.
function privateGroupCacheCode(groupId) { return `group:${groupId}`; }

const privateGroupDownloads = new Map();

// Leaving, deleting or being removed from a group takes its saved downloads with it.
function forgetPrivateGroupDownloads(groupId) {
  if (groupId) attachmentCacheClearRoom(privateGroupCacheCode(groupId)).catch(() => {});
}

// The encrypted attachment text, from this device when it is already there.
// messageId ties the saved copy to its message, so deleting the message
// deletes the copy too.
function downloadPrivateGroupAttachment(state, group, attachmentId, messageId = '') {
  const key = `${group.id}:${attachmentId}`;
  if (privateGroupDownloads.has(key)) return privateGroupDownloads.get(key);
  const job = fetchPrivateGroupAttachment(state, group, attachmentId, messageId).finally(() => privateGroupDownloads.delete(key));
  privateGroupDownloads.set(key, job);
  return job;
}

async function fetchPrivateGroupAttachment(state, group, attachmentId, messageId) {
  const cacheCode = privateGroupCacheCode(group.id);
  const cached = await attachmentCacheGet(cacheCode, attachmentId);
  if (cached) return cached;
  let lastError = new Error('Could not open attachment');
  for (let attempt = 0; attempt < ATTACHMENT_DOWNLOAD_RETRY_DELAYS_MS.length; attempt++) {
    const delay = ATTACHMENT_DOWNLOAD_RETRY_DELAYS_MS[attempt];
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const controller = new AbortController();
    let stall = null;
    const armStall = () => { clearTimeout(stall); stall = setTimeout(() => controller.abort(), ATTACHMENT_STALL_MS); };
    armStall();
    try {
      const response = await fetch('/api/groups/attachment/content', { method:'POST', headers:{ 'Content-Type':'application/json' },
        body:JSON.stringify({ accountId:state.accountId, sessionToken:state.sessionToken, groupId:group.id, attachmentId }),
        cache:'no-store', signal:controller.signal });
      if (!response.ok) { const error = new Error('Could not open attachment'); error.status = response.status; throw error; }
      const ciphertext = await readAttachmentBody(response, armStall);
      if (!ciphertext || new Blob([ciphertext]).size > MAX_PRIVATE_GROUP_ATTACHMENT_BYTES) throw Object.assign(new Error('Invalid attachment'), { status:422 });
      attachmentCachePut(cacheCode, attachmentId, messageId, ciphertext).catch(() => {});
      return ciphertext;
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      const retryable = !status || status === 404 || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
      if (!retryable || attempt === ATTACHMENT_DOWNLOAD_RETRY_DELAYS_MS.length - 1) break;
    } finally { clearTimeout(stall); }
  }
  throw lastError;
}

async function sendPrivateGroupAttachment(payload, onProgress) {
  const state = loadAccountState(); const group = privateGroups.get(activePrivateGroupId);
  const key = group?.keys?.[group?.keyVersion];
  if (!state || !group || !key) throw new Error('Group encryption key is not ready');
  const messageId = newMsgId();
  const pending = { id:messageId, senderId:state.accountId, attachmentId:null, attachment:payload,
    createdAt:Date.now(), keyVersion:group.keyVersion, pending:true };
  group.messages = [...(group.messages || []), pending]; renderPrivateGroupMessages(group);
  try {
    onProgress?.('Encrypting attachment…');
    const encryptedPayload = await encryptPrivateGroupValue(key, payload);
    onProgress?.('Sending securely…');
    const attachmentId = await uploadPrivateGroupAttachment(state, group, messageId, encryptedPayload);
    // We just made this ciphertext, so keep it: our own photo must not be downloaded back.
    attachmentCachePut(privateGroupCacheCode(group.id), attachmentId, messageId, encryptedPayload).catch(() => {});
    const ciphertext = await encryptPrivateGroupValue(key, { type:'group-attachment', attachmentId });
    const result = await api('/api/groups/send', { accountId:state.accountId, sessionToken:state.sessionToken,
      groupId:group.id, messageId, ciphertext, attachmentId });
    if (result.error) throw new Error(result.error);
    pending.attachmentId = attachmentId; pending.createdAt = result.createdAt; pending.keyVersion = result.keyVersion; pending.pending = false;
    group.updatedAt = result.createdAt; renderPrivateGroupMessages(group); renderVaultList();
  } catch (error) {
    group.messages = (group.messages || []).filter(message => message !== pending);
    renderPrivateGroupMessages(group); throw error;
  }
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
    const isVideo = String(file.type || '').startsWith('video/');
    let attachmentName = file.name;
    const progress = beginPhotoSendProgress(1, isVideo ? 'Encrypting video…' : (String(file.type || '').startsWith('image/') ? 'Encrypting image…' : 'Encrypting attachment…'));
    try {
      if (file.size > MAX_PRIVATE_GROUP_FILE_BYTES) { toast(`“${file.name}” is too large — maximum 25MB`); continue; }
      let base64, mime = file.type || 'application/octet-stream';
      if (mime.startsWith('image/')) {
        progress.update('Encrypting image…');
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
        const compressed = await compressImageFile(file); base64 = compressed.base64; mime = compressed.mime;
        if (!await allowLocalImageSend([base64], progress.update, { persist:true })) continue;
      } else {
        progress.update(isVideo ? 'Optimising video…' : 'Encrypting attachment…');
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
        const compressedVideo = isVideo ? await compressVideoFile(file) : null;
        base64 = compressedVideo?.base64 || await fileToBase64(file);
        if (compressedVideo) { attachmentName = compressedVideo.name; mime = compressedVideo.mime; }
      }
      const videoThumb = isVideo ? await createVideoAttachmentThumbnail(file) : null;
      // Same first-page thumbnail and page count as direct conversations; both
      // ride inside the encrypted payload, never as plaintext.
      const pdfPreview = !mime.startsWith('image/') && isPdfAttachment(mime, attachmentName)
        ? await createPdfFirstPagePreview(base64) : null;
      await sendPrivateGroupAttachment({ type:mime.startsWith('image/') ? 'group-image' : 'group-file',
        name:String(attachmentName || 'Attachment').slice(0,180), mime, size:Math.ceil(base64.length * 3 / 4), data:base64,
        ...(videoThumb && safeImageDataUri('image/jpeg', videoThumb) ? { videoThumb } : {}),
        ...(pdfPreview ? { pdfPreview:pdfPreview.base64, pageCount:pdfPreview.pageCount } : {}) }, progress.update);
      toast(mime.startsWith('image/') ? 'Photo sent' : (isVideo ? 'Video sent' : 'File sent'));
    } catch (error) { toast(error.message || 'Attachment could not be sent'); }
    finally { progress.close(); }
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
        if (blob.size > MAX_PRIVATE_GROUP_FILE_BYTES) throw new Error('Voice note is too large — record a shorter note');
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

// A device can lose its local copy of a group's keys while the encrypted
// account backup still holds them. Members can rebuild theirs from the server,
// but the creator generated the key locally and has no server copy, so the
// backup is their only way back. Read-only: fetch, decrypt with this
// account's master key, and merge in only key versions that are missing. Tried
// once per session so a backup without the key is not re-fetched on every poll.
let privateGroupBackupRestoreTried = false;

async function restorePrivateGroupKeysFromBackup() {
  if (privateGroupBackupRestoreTried) return false;
  privateGroupBackupRestoreTried = true;
  const state = loadAccountState();
  if (!state?.masterKey) return false;
  try {
    const latest = await api('/api/account/fetch', { accountId:state.accountId, sessionToken:state.sessionToken });
    if (latest.error || !latest.bundle) return false;
    const bundle = await aesDecryptJson(base64UrlToBytes(state.masterKey), latest.bundle);
    let restored = false;
    for (const backedUp of bundle?.groups || []) {
      const group = privateGroups.get(backedUp?.id);
      if (!group || backedUp.ownerAccountId !== state.accountId || !hasPrivateGroupKeys(backedUp)) continue;
      const merged = { ...backedUp.keys, ...(group.keys || {}) };
      if (Object.keys(merged).length <= Object.keys(group.keys || {}).length) continue;
      group.keys = merged; restored = true;
      // Anything read while the key was missing was marked unavailable; read it again.
      group.messages = []; group.messageCursor = 0; group.historyHydrated = false;
      if (group.encryptedName && merged[group.keyVersion]) {
        try { group.name = await decryptPrivateGroupValue(merged[group.keyVersion], group.encryptedName); } catch (_) {}
      }
    }
    return restored;
  } catch (error) { console.warn('Private group keys could not be restored from the backup'); return false; }
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
  for (const id of [...privateGroups.keys()]) if (!live.has(id)) { forgetPrivateGroupDownloads(id); privateGroups.delete(id); }
  if ([...privateGroups.values()].some(group => !group.keys?.[group.keyVersion])) await restorePrivateGroupKeysFromBackup();
  savePrivateGroupSessions();
  if (receivedNewKey) scheduleAccountSync();
  if (document.getElementById('s-vault-list')?.classList.contains('active')) renderVaultList();
  preloadPrivateGroupsInBackground();
  if (activePrivateGroupId && privateGroups.has(activePrivateGroupId)) {
    await preloadPrivateGroup(activePrivateGroupId, { priority:true });
    renderPrivateGroupMessages(privateGroups.get(activePrivateGroupId));
  }
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
    privateGroups.set(result.group.id, { ...result.group, name, keys:{ 1:encodedKey }, ownerAccountId:state.accountId, messages:[], unread:0, historyHydrated:true });
    savePrivateGroupSessions(); scheduleAccountSync(); closeCreateGroup(); renderVaultList();
    toast('Private group created'); openPrivateGroup(result.group.id);
  } catch (error) { toast(error.message || 'Could not create the private group'); }
  finally { button.disabled = false; button.textContent = 'Create group'; }
}

async function openPrivateGroup(id) {
  const group = privateGroups.get(id); if (!group) return;
  const requestId = ++privateGroupOpenRequestId;
  openingPrivateGroupId = group.historyHydrated ? null : id;
  renderVaultList();
  try {
    activePrivateGroupId = id; group.unread = 0;
    const input = document.getElementById('group-message-input');
    if (input) input.value = '';
    updatePrivateGroupComposer();
    document.getElementById('group-chat-title').textContent = group.name || 'Private group';
    document.getElementById('group-chat-sub').textContent = `${group.members?.length || 1} members · end-to-end encrypted`;
    renderPrivateGroupMessages(group);
    document.getElementById('group-chat').classList.add('open');
    document.getElementById('group-chat').setAttribute('aria-hidden','false');
    clearInterval(groupPollTimer); groupPollTimer = setInterval(() => pollPrivateGroup(false), 3000);
    // The normal path is already hydrated by the inbox preloader. If the
    // user taps during a cold launch, open the group shell immediately and
    // promote its queued preload instead of leaving them on the inbox.
    if (!group.historyHydrated) {
      const ready = await preloadPrivateGroup(id, { priority:true });
      if (requestId !== privateGroupOpenRequestId) return;
      if (!ready) { toast('Could not load this encrypted group. Try again.'); return; }
      renderPrivateGroupMessages(group);
    }
  } catch (_) {
    if (requestId === privateGroupOpenRequestId) toast('Could not open this encrypted group. Try again.');
  } finally {
    if (requestId === privateGroupOpenRequestId) {
      openingPrivateGroupId = null;
      if (document.getElementById('s-vault-list')?.classList.contains('active')) renderVaultList();
    }
  }
}

function closePrivateGroup() {
  privateGroupOpenRequestId++;
  openingPrivateGroupId = null;
  clearInterval(groupPollTimer); groupPollTimer = null;
  closePrivateGroupAttachOptions();
  if (privateGroupVoiceRecorder?.state === 'recording') {
    privateGroupVoiceRecorder.onstop = null; privateGroupVoiceRecorder.stop();
    privateGroupVoiceStream?.getTracks().forEach(track => track.stop()); privateGroupVoiceStream = null;
  }
  cancelPrivateGroupReply(); exitPrivateGroupSelectMode();
  activePrivateGroupId = null;
  document.getElementById('group-chat')?.classList.remove('open');
  document.getElementById('group-chat')?.setAttribute('aria-hidden','true'); renderVaultList();
}

// ---- reply / reaction / delete plumbing ------------------------------------
// Reactions and deletes are small control messages in the same encrypted stream
// as ordinary messages. They are applied here and never drawn as bubbles.
const GROUP_REACTIONS = ['👍','❤️','😂','😮','😢','🙏'];
let groupReplyTo = null;
let groupSelectMode = false;
const groupSelectedIds = new Set();

function sanitizeGroupReply(value) {
  if (!value || typeof value !== 'object') return undefined;
  const id = typeof value.id === 'string' && value.id.length <= 96 ? value.id : '';
  if (!id) return undefined;
  const kind = ['text', 'image', 'file', 'voice', 'gif'].includes(value.kind) ? value.kind : 'text';
  return { id, kind,
    name:String(value.name || '').slice(0, 60),
    text:String(value.text || '').slice(0, 160) };
}

function groupMessageKind(message) {
  if (message.attachment?.type === 'group-image') return 'image';
  if (message.attachment?.type === 'group-voice') return 'voice';
  if (message.attachment?.type === 'group-file') return 'file';
  if (message.gif) return 'gif';
  return 'text';
}

function groupMessagePreview(message) {
  switch (groupMessageKind(message)) {
    case 'image': return 'Photo';
    case 'voice': return 'Voice note';
    case 'gif': return 'GIF';
    case 'file': return message.attachment?.name || 'File';
    default: return String(message.text || '').slice(0, 160);
  }
}

// Which messages are shown and which reactions each carries, from the raw
// stream. A delete only counts when the person who sent it also sent the
// message it targets, so no member can remove another member's message.
// `hiddenIds` are this device's own "delete for me" choices.
function privateGroupDeletedIds(messages, hiddenIds = []) {
  const byId = new Map(messages.map(message => [message.id, message]));
  const deleted = new Set(hiddenIds);
  for (const message of messages) {
    const control = message.control;
    if (control?.type !== 'delete') continue;
    const target = byId.get(control.target);
    if (target && !target.control && target.senderId === message.senderId) deleted.add(control.target);
  }
  return deleted;
}

function derivePrivateGroupView(messages, hiddenIds = []) {
  const byId = new Map(messages.map(message => [message.id, message]));
  const deleted = privateGroupDeletedIds(messages, hiddenIds);
  const reactions = new Map();
  for (const message of messages) {
    const control = message.control; if (!control) continue;
    const target = byId.get(control.target);
    if (!target || target.control) continue;
    if (control.type === 'reaction') {
      if (!reactions.has(control.target)) reactions.set(control.target, new Map());
      if (control.emoji) reactions.get(control.target).set(message.senderId, control.emoji);
      else reactions.get(control.target).delete(message.senderId);
    }
  }
  return { visible:messages.filter(message => !message.control && !deleted.has(message.id)), reactions };
}

function groupReactionChipsHtml(reactionMap, myId) {
  if (!reactionMap?.size) return '';
  const counts = new Map(); let mine = null;
  for (const [sender, emoji] of reactionMap) {
    counts.set(emoji, (counts.get(emoji) || 0) + 1);
    if (sender === myId) mine = emoji;
  }
  return `<div class="group-reactions">${[...counts].map(([emoji, count]) =>
    `<span class="msg-reaction-badge${emoji === mine ? ' mine' : ''}">${emoji}${count > 1 ? `<small>${count}</small>` : ''}</span>`).join('')}</div>`;
}

function renderPrivateGroupMessages(group) {
  const body = document.getElementById('group-chat-body'); if (!body) return;
  const state = loadAccountState();
  if (!hasPrivateGroupKeys(group)) {
    body.innerHTML = '<div class="group-chat-empty">This device does not have the encryption key for this group.<br>Your messages are safe and unchanged for the other members. Reopen Vaultlix to try restoring the key from your encrypted backup.</div>';
    return;
  }
  if (!group.historyHydrated) {
    body.innerHTML = '<div class="group-chat-empty">Loading encrypted messages…</div>';
    return;
  }
  const { visible, reactions } = derivePrivateGroupView(group.messages || [], group.hiddenIds || []);
  if (!visible.length) { body.innerHTML = '<div class="group-chat-empty">This private group is ready.<br>Send the first encrypted message.</div>'; return; }
  body.innerHTML = visible.map(message => {
    let content;
    const kind = groupMessageKind(message);
    // Same long-press action row as a direct conversation. Hidden, blocked or
    // unreadable content only offers Select and Delete.
    let usable = true;
    if (message.attachment?.type === 'group-image') {
      // Same photo markup and in-app viewer as direct conversations: tapping
      // opens viewImage(), and saving is an explicit action inside it.
      const safeSrc = safeImageDataUri(message.attachment.mime, message.attachment.data);
      content = message.imageSafety && message.imageSafety !== 'allowed'
        ? '<div class="group-attachment-status">Photo hidden because the on-device safety check could not approve it.</div>'
        : (safeSrc
          ? `<div class="msg-media-wrap"><img class="msg-image" src="${safeSrc}" alt="${escHtml(message.attachment.name || 'Group photo')}" onclick="openPrivateGroupImage('${escHtml(message.id)}')" oncontextmenu="return false" draggable="false"/></div>`
          : MEDIA_BLOCKED_HTML);
      usable = !!safeSrc && !(message.imageSafety && message.imageSafety !== 'allowed');
      if (message.pending) content = `<div class="msg-upload-pending">${content}${attachmentUploadAnimationHtml()}</div>`;
    } else if (message.attachment?.type === 'group-voice') {
      const mime = /^audio\/[a-z0-9.+-]+(?:;codecs=[a-z0-9.+-]+)?$/i.test(message.attachment.mime) ? message.attachment.mime : 'audio/webm';
      content = `<audio class="group-message-attachment" controls preload="metadata" src="data:${mime};base64,${escHtml(message.attachment.data)}"></audio>`;
    } else if (message.attachment?.type === 'group-file') {
      // Same cards as direct conversations: a first-page preview card for
      // PDFs, the plain file card (.msg-file) for everything else.
      const isVideo = String(message.attachment.mime || '').startsWith('video/');
      const card = isVideo
        ? buildVideoAttachmentHtml({ id:message.id, name:message.attachment.name, thumb:message.attachment.videoThumb, pending:!!message.pending, group:true })
        : isPdfAttachment(message.attachment.mime, message.attachment.name)
        ? privateGroupPdfCardHtml(message)
        : `<div class="msg-file" onclick="openPrivateGroupAttachment('${escHtml(message.id)}')" oncontextmenu="return false">
        <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span>${escHtml(message.attachment.name || 'Attachment')}</span>
      </div>`;
      content = `<div class="msg-media-wrap">${message.pending && !isVideo
        ? `<div class="msg-upload-pending">${card}${attachmentUploadAnimationHtml()}</div>`
        : card}</div>`;
    } else if (message.gif?.type === 'group-gif' && safeKlipyMediaUrl(message.gif.url)) {
      content = `<div class="group-message-attachment"><img src="${escHtml(message.gif.url)}" alt="${escHtml(message.gif.title || 'GIF')}" loading="lazy"></div>`;
    } else {
      const unsafe = message.senderId !== state?.accountId && (!window.VaultlixContentSafety || window.VaultlixContentSafety.check(message.text).blocked);
      const visibleText = unsafe ? 'Potentially harmful message hidden. Use the member menu to remove this person.' : message.text;
      content = `<div class="group-message-text">${escHtml(visibleText)}</div>`;
      usable = !unsafe && !message.unavailable && typeof message.text === 'string' && !!message.text.trim();
    }
    const mine = message.senderId === state?.accountId;
    const buttons = usable
      ? [msgActionBtn('reply', 'Reply'), msgActionBtn('react', 'React'),
         kind === 'text' ? msgActionBtn('copy', 'Copy') : (['image', 'file', 'voice'].includes(kind) ? msgActionBtn('save', 'Save') : ''),
         ['text', 'image', 'file'].includes(kind) ? msgActionBtn('forward', 'Forward') : '',
         msgActionBtn('select', 'Select'), msgActionBtn('delete', 'Delete')]
      : [msgActionBtn('select', 'Select'), msgActionBtn('delete', 'Delete')];
    const actions = `<div class="msg-actions" id="actions-${escHtml(message.id)}">${buttons.join('')}</div>`
      + (usable ? `<div class="reaction-picker" id="picker-${escHtml(message.id)}">${GROUP_REACTIONS.map(emoji => `<span data-emoji="${emoji}">${emoji}</span>`).join('')}</div>` : '');
    const quote = message.reply
      ? `<div class="msg-reply-quote group-reply-quote" data-reply-to="${escHtml(message.reply.id)}"><strong>${escHtml(message.reply.name || 'Member')}</strong> ${escHtml(message.reply.kind === 'text' ? message.reply.text : `${{ image:'📷', voice:'🎤', gif:'GIF', file:'📎' }[message.reply.kind] || ''} ${message.reply.text || ''}`)}</div>` : '';
    // The bubble is one element; the action row and reaction strip sit under it
    // (not inside it), exactly where a direct conversation puts them.
    return `<div class="group-msg${mine ? ' mine' : ''}" data-group-msg-id="${escHtml(message.id)}" data-usable="${usable ? '1' : '0'}"><div class="group-message-select"></div><div class="group-message${mine ? ' mine' : ''}"><div class="group-message-name">${escHtml(groupMemberLabel(group, message.senderId))}</div>${quote}${content}${groupReactionChipsHtml(reactions.get(message.id), state?.accountId)}<div class="group-message-time">${escHtml(new Date(message.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}))}</div></div>${actions}</div>`;
  }).join('');
  for (const row of body.querySelectorAll('[data-group-msg-id]')) wirePrivateGroupMessage(row);
  if (groupSelectMode) refreshPrivateGroupSelection();
  body.scrollTop = body.scrollHeight;
  fillPrivateGroupPdfPreviews(group.id);
}

// Long-press anywhere on a message opens its action row (a tap on text does
// too), exactly like a direct conversation. In selection mode both just
// tick or untick the message.
function wirePrivateGroupMessage(row) {
  const id = row.dataset.groupMsgId;
  attachLongPress(row.querySelector('.group-message'), id, () => { if (groupSelectMode) togglePrivateGroupSelection(id); else toggleMsgActions(id); });
  row.addEventListener('click', event => {
    if (groupSelectMode) { event.preventDefault(); event.stopPropagation(); togglePrivateGroupSelection(id); return; }
    if (event.target.closest('.group-message-text') && !window.getSelection()?.toString()) toggleMsgActions(id);
  }, true);
  const quote = row.querySelector('[data-reply-to]');
  if (quote) quote.onclick = event => { if (!groupSelectMode) { event.stopPropagation(); jumpToPrivateGroupMessage(quote.dataset.replyTo); } };
  const act = (name, handler) => { const button = row.querySelector(`[data-action="${name}"]`); if (button) button.onclick = event => { event.stopPropagation(); handler(); }; };
  act('reply', () => startPrivateGroupReply(id));
  act('react', () => document.getElementById(`picker-${id}`)?.classList.toggle('show'));
  act('copy', () => copyPrivateGroupText(id));
  act('save', () => savePrivateGroupAttachment(id));
  act('forward', () => forwardPrivateGroupMessage(id));
  act('select', () => { closeAllMsgActions(); enterPrivateGroupSelectMode(id); });
  act('delete', () => { closeAllMsgActions(); showPrivateGroupDeleteOptions([id]); });
  row.querySelectorAll('.reaction-picker [data-emoji]').forEach(span => {
    span.onclick = event => { event.stopPropagation(); closeAllMsgActions(); sendPrivateGroupReaction(id, span.dataset.emoji); };
  });
}

function jumpToPrivateGroupMessage(id) {
  const target = document.querySelector(`#group-chat-body [data-group-msg-id="${CSS.escape(id)}"]`);
  if (!target) { toast('That message is no longer on this device'); return; }
  target.scrollIntoView({ block:'center', behavior:'smooth' });
  target.classList.add('flash');
  setTimeout(() => target.classList.remove('flash'), 1200);
}

function privateGroupMessageById(messageId) {
  return privateGroups.get(activePrivateGroupId)?.messages?.find(message => message.id === messageId) || null;
}

function privateGroupTextById(messageId) {
  const text = privateGroupMessageById(messageId)?.text;
  return typeof text === 'string' && text.trim() ? text : null;
}

async function copyPrivateGroupText(messageId) {
  closeAllMsgActions();
  const text = privateGroupTextById(messageId); if (!text) return;
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch (_) { toast('Press and hold the message to copy it'); }
}

// Forward a group message into a one-to-one conversation. Text is already
// decrypted on this device and is sent again under the chosen conversation's
// own key through the ordinary send route; photos and files do the same.
function forwardPrivateGroupText(messageId) {
  closeAllMsgActions();
  const text = privateGroupTextById(messageId); if (!text) return;
  showForwardAttachmentPicker({ kind:'text', text }, { includeActiveRoom:true });
}

function forwardPrivateGroupMessage(messageId) {
  const message = privateGroupMessageById(messageId); if (!message) return;
  if (groupMessageKind(message) === 'text') forwardPrivateGroupText(messageId);
  else forwardPrivateGroupAttachment(messageId);
}

// ---- reply ------------------------------------------------------------------
function startPrivateGroupReply(messageId) {
  closeAllMsgActions();
  const group = privateGroups.get(activePrivateGroupId); const message = privateGroupMessageById(messageId);
  if (!group || !message) return;
  groupReplyTo = sanitizeGroupReply({ id:message.id, kind:groupMessageKind(message),
    name:groupMemberLabel(group, message.senderId), text:groupMessagePreview(message) });
  const bar = document.getElementById('group-reply-preview'); if (!bar || !groupReplyTo) return;
  bar.querySelector('.group-reply-name').textContent = groupReplyTo.name || 'Member';
  bar.querySelector('.group-reply-snippet').textContent = groupReplyTo.text || '';
  bar.classList.add('show');
  document.getElementById('group-message-input')?.focus();
}

function cancelPrivateGroupReply() {
  groupReplyTo = null;
  document.getElementById('group-reply-preview')?.classList.remove('show');
}

// ---- reactions and deletes (control messages) --------------------------------
async function sendPrivateGroupControl(payload, control) {
  const state = loadAccountState(); const group = privateGroups.get(activePrivateGroupId);
  const key = group?.keys?.[group?.keyVersion];
  if (!state || !group || !key) throw new Error('Group encryption key is not ready');
  const messageId = newMsgId();
  const ciphertext = await encryptPrivateGroupValue(key, payload);
  const result = await api('/api/groups/send', { accountId:state.accountId, sessionToken:state.sessionToken,
    groupId:group.id, messageId, ciphertext });
  if (result.error) throw new Error(result.error);
  group.messages = [...(group.messages || []), { id:messageId, senderId:state.accountId, control,
    createdAt:result.createdAt, keyVersion:result.keyVersion }];
  group.updatedAt = result.createdAt;
}

async function sendPrivateGroupReaction(messageId, emoji) {
  const group = privateGroups.get(activePrivateGroupId); const state = loadAccountState();
  if (!group || !state || !GROUP_REACTIONS.includes(emoji)) return;
  // Tapping your own current reaction again clears it, as in a direct chat.
  const current = derivePrivateGroupView(group.messages || [], group.hiddenIds || []).reactions.get(messageId)?.get(state.accountId);
  const next = current === emoji ? '' : emoji;
  try {
    await sendPrivateGroupControl({ type:'group-reaction', target:messageId, emoji:next }, { type:'reaction', target:messageId, emoji:next });
    renderPrivateGroupMessages(group);
  } catch (error) { toast(error.message || 'Reaction could not be sent'); }
}

function showPrivateGroupDeleteOptions(ids) {
  const group = privateGroups.get(activePrivateGroupId); const state = loadAccountState();
  if (!group || !state || !ids.length) return;
  const allMine = ids.every(id => privateGroupMessageById(id)?.senderId === state.accountId);
  document.getElementById('group-delete-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'group-delete-overlay';
  overlay.className = 'group-delete-overlay';
  overlay.innerHTML = `<div class="group-delete-card"><div class="group-delete-title">${ids.length > 1 ? `Delete ${ids.length} messages?` : 'Delete this message?'}</div>
    ${allMine ? '<button type="button" class="everyone" data-delete="everyone">Delete for everyone</button>' : ''}
    <button type="button" class="me" data-delete="me">Delete for me</button>
    <button type="button" class="cancel" data-delete="cancel">Cancel</button></div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  overlay.querySelector('[data-delete="cancel"]').onclick = close;
  overlay.querySelector('[data-delete="me"]').onclick = () => { close(); deletePrivateGroupMessages(ids, false); };
  const everyone = overlay.querySelector('[data-delete="everyone"]');
  if (everyone) everyone.onclick = () => { close(); deletePrivateGroupMessages(ids, true); };
}

async function deletePrivateGroupMessages(ids, forEveryone) {
  const group = privateGroups.get(activePrivateGroupId); if (!group) return;
  exitPrivateGroupSelectMode();
  // Gone from this device straight away either way, as in a direct chat.
  group.hiddenIds = [...new Set([...(group.hiddenIds || []), ...ids])].slice(-500);
  for (const id of ids) attachmentCacheDeleteForMessage(privateGroupCacheCode(group.id), id);
  savePrivateGroupSessions(); renderPrivateGroupMessages(group);
  if (!forEveryone) return;
  try {
    for (const id of ids) await sendPrivateGroupControl({ type:'group-delete', target:id }, { type:'delete', target:id });
  } catch (error) { toast(error.message || 'Could not delete for everyone'); }
}

// ---- selection --------------------------------------------------------------
function enterPrivateGroupSelectMode(firstId) {
  groupSelectMode = true; groupSelectedIds.clear(); if (firstId) groupSelectedIds.add(firstId);
  cancelPrivateGroupReply();
  document.getElementById('group-chat')?.classList.add('selecting');
  refreshPrivateGroupSelection();
}

function exitPrivateGroupSelectMode() {
  groupSelectMode = false; groupSelectedIds.clear();
  document.getElementById('group-chat')?.classList.remove('selecting');
  refreshPrivateGroupSelection();
}

function togglePrivateGroupSelection(id) {
  if (groupSelectedIds.has(id)) groupSelectedIds.delete(id); else groupSelectedIds.add(id);
  if (!groupSelectedIds.size) { exitPrivateGroupSelectMode(); return; } // unticking the last one leaves selection
  refreshPrivateGroupSelection();
}

function refreshPrivateGroupSelection() {
  document.querySelectorAll('#group-chat-body [data-group-msg-id]').forEach(row => {
    const on = groupSelectMode && groupSelectedIds.has(row.dataset.groupMsgId);
    row.classList.toggle('selected', on);
    const badge = row.querySelector('.group-message-select'); if (badge) badge.textContent = on ? '✓' : '';
  });
  const count = document.getElementById('group-select-count');
  if (count) count.textContent = `${groupSelectedIds.size} selected`;
}

function deleteSelectedPrivateGroupMessages() {
  if (groupSelectedIds.size) showPrivateGroupDeleteOptions([...groupSelectedIds]);
}

// Mirrors the direct-conversation PDF card: first-page thumbnail (or a PDF
// placeholder for files sent before thumbnails existed), page count and size.
// pdfPreview and pageCount come from a peer, so they are validated here.
function privateGroupPdfPreviewHtml(attachment) {
  const thumbnail = safeImageDataUri('image/jpeg', attachment.pdfPreview);
  return thumbnail
    ? `<img src="${thumbnail}" alt="First page of ${escHtml(attachment.name || 'PDF')}" draggable="false"/>`
    : '<span class="msg-pdf-placeholder"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>PDF</span>';
}

function privateGroupPdfMeta(attachment) {
  const pages = Number(attachment.pageCount) || 0;
  const pageLabel = pages > 0 && pages < 100000 ? `${pages} page${pages === 1 ? '' : 's'} · ` : '';
  return `${pageLabel}${formatFileSize(Math.ceil(String(attachment.data || '').length * 3 / 4))} · PDF`;
}

function privateGroupPdfCardHtml(message) {
  const attachment = message.attachment;
  const preview = privateGroupPdfPreviewHtml(attachment);
  return `<div class="msg-pdf-card" onclick="openPrivateGroupAttachment('${escHtml(message.id)}')" oncontextmenu="return false">
    <div class="msg-pdf-preview">${preview}</div>
    <div class="msg-pdf-info"><span class="msg-pdf-icon">PDF</span><span class="msg-pdf-copy"><span class="msg-pdf-name">${escHtml(attachment.name || 'Document.pdf')}</span><span class="msg-pdf-meta">${privateGroupPdfMeta(attachment)}</span></span></div>
  </div>`;
}

// PDFs sent before thumbnails existed (or by a client that could not render
// one) arrive without a preview. Render the first page on this device instead,
// one PDF at a time, and patch the card in place so the list does not redraw
// or jump. Failures are remembered so a broken PDF is not retried in a loop.
const privateGroupPdfPreviewFailed = new Set();
let privateGroupPdfPreviewBusy = false;

async function fillPrivateGroupPdfPreviews(groupId) {
  if (privateGroupPdfPreviewBusy) return;
  privateGroupPdfPreviewBusy = true;
  try {
    while (activePrivateGroupId === groupId) {
      const message = privateGroups.get(groupId)?.messages?.find(item => item.attachment?.type === 'group-file'
        && isPdfAttachment(item.attachment.mime, item.attachment.name)
        && !safeImageDataUri('image/jpeg', item.attachment.pdfPreview)
        && !privateGroupPdfPreviewFailed.has(item.id));
      if (!message) break;
      const preview = await createPdfFirstPagePreview(message.attachment.data);
      if (!preview) { privateGroupPdfPreviewFailed.add(message.id); continue; }
      message.attachment.pdfPreview = preview.base64;
      message.attachment.pageCount = preview.pageCount;
      const card = [...document.querySelectorAll('#group-chat-body [data-actionable-id]')]
        .find(row => row.dataset.actionableId === message.id)?.querySelector('.msg-pdf-card');
      if (card) {
        card.querySelector('.msg-pdf-preview').innerHTML = privateGroupPdfPreviewHtml(message.attachment);
        card.querySelector('.msg-pdf-meta').textContent = privateGroupPdfMeta(message.attachment);
      }
    }
  } catch (error) { console.warn('Group PDF previews could not be prepared'); }
  finally { privateGroupPdfPreviewBusy = false; }
}

// The group chat is a full-screen overlay at z-index 10018, so the shared
// viewers (which default to lower z-indexes) must be raised above it.
const PRIVATE_GROUP_VIEWER_Z = 10022;

function openPrivateGroupImage(messageId) {
  if (wasJustLongPressed()) return;
  const group = privateGroups.get(activePrivateGroupId);
  const attachment = group?.messages?.find(message => message.id === messageId)?.attachment;
  const src = attachment ? safeImageDataUri(attachment.mime, attachment.data) : null;
  if (!src) { toast('Could not open photo'); return; }
  viewImage(src, { zIndex:PRIVATE_GROUP_VIEWER_Z });
}

function openPrivateGroupVideo(messageId) {
  if (wasJustLongPressed()) return;
  const group = privateGroups.get(activePrivateGroupId);
  const attachment = group?.messages?.find(message => message.id === messageId)?.attachment;
  if (!attachment?.data || !String(attachment.mime || '').startsWith('video/')) { toast('Could not open video'); return; }
  openVideoAttachmentViewer(attachment.mime, attachment.data, attachment.name || 'Video');
}

// Mirrors handleFileTap in direct conversations: PDFs open in the in-app
// preview, every other file is saved through downloadDataUri.
function openPrivateGroupAttachment(messageId) {
  if (wasJustLongPressed()) return;
  const group = privateGroups.get(activePrivateGroupId);
  const attachment = group?.messages?.find(message => message.id === messageId)?.attachment;
  if (!attachment?.data) return;
  const mime = /^[a-z]+\/[a-z0-9.+-]+(?:;codecs=[a-z0-9.+-]+)?$/i.test(attachment.mime) ? attachment.mime : 'application/octet-stream';
  if (isPdfAttachment(mime, attachment.name)) {
    const thumbnail = safeImageDataUri('image/jpeg', attachment.pdfPreview) ? attachment.pdfPreview : null;
    openPdfPreview({ mime, base64:attachment.data, fileName:attachment.name || 'Document.pdf', pdfPreview:thumbnail, pageCount:Number(attachment.pageCount) || 0 });
    const overlay = document.getElementById('pdf-preview-overlay');
    if (overlay) overlay.style.zIndex = String(PRIVATE_GROUP_VIEWER_Z);
    return;
  }
  downloadDataUri(`data:${mime};base64,${attachment.data}`, attachment.name || 'Vaultlix attachment');
}

function privateGroupAttachmentById(messageId) {
  const group = privateGroups.get(activePrivateGroupId);
  const attachment = group?.messages?.find(message => message.id === messageId)?.attachment;
  if (!attachment?.data || !['group-image', 'group-file', 'group-voice'].includes(attachment.type)) return null;
  const mime = /^[a-z]+\/[a-z0-9.+-]+(?:;codecs=[a-z0-9.+-]+)?$/i.test(attachment.mime) ? attachment.mime : 'application/octet-stream';
  return { attachment, mime };
}

// The "Save" action in the long-press row, same as direct conversations.
function savePrivateGroupAttachment(messageId) {
  closeAllMsgActions();
  const found = privateGroupAttachmentById(messageId); if (!found) return;
  const { attachment, mime } = found;
  const voiceExt = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
  const fallbackName = attachment.type === 'group-image' ? 'vaultlix-image'
    : (attachment.type === 'group-voice' ? `voice-note.${voiceExt}` : 'Vaultlix attachment');
  downloadDataUri(`data:${mime};base64,${attachment.data}`, attachment.name || fallbackName);
}

// Forward reuses the direct-conversation picker and send path, exactly as a
// forwarded 1:1 attachment does: the already-decrypted file stays on this
// device, is re-encrypted with the chosen conversation's own key, and is sent
// through the ordinary /api/send route. includeActiveRoom is needed because a
// group is not one of the direct rooms, so no room is "the current one" here.
function forwardPrivateGroupAttachment(messageId) {
  closeAllMsgActions();
  const found = privateGroupAttachmentById(messageId); if (!found || found.attachment.type === 'group-voice') return;
  const { attachment, mime } = found;
  const isImage = attachment.type === 'group-image';
  if (isImage ? !safeImageDataUri(mime, attachment.data) : !isValidMediaBase64(attachment.data)) { toast('Could not forward this attachment'); return; }
  const thumbnail = safeImageDataUri('image/jpeg', attachment.pdfPreview) ? attachment.pdfPreview : null;
  showForwardAttachmentPicker({
    kind:'file', fileName:attachment.name || (isImage ? 'vaultlix-image' : 'vaultlix-file'), mime, base64:attachment.data,
    isImage, pdfPreview:thumbnail, videoThumb:safeImageDataUri('image/jpeg', attachment.videoThumb) ? attachment.videoThumb : null,
    pageCount:Number(attachment.pageCount) || 0, viewOnce:false,
  }, { includeActiveRoom:true });
}

// Reads everything that is not an attachment. An attachment message comes back
// as { pending } so the caller can decide whether it is worth downloading.
async function decodePrivateGroupEnvelope(group, message) {
  const plaintext = await decryptPrivateGroupValue(group.keys?.[message.keyVersion], message.ciphertext);
  let metadata = null;
  try { metadata = JSON.parse(plaintext); } catch (_) {}
  if (metadata?.type === 'group-gif' && safeKlipyMediaUrl(metadata.url)) return { decoded:{ ...message, gif:metadata } };
  // Replies, reactions and deletes ride inside the same encrypted message
  // stream. Everything here comes from another member, so each field is
  // checked and trimmed before it is ever shown.
  if (metadata?.type === 'group-text' && typeof metadata.text === 'string') {
    return { decoded:{ ...message, text:metadata.text, reply:sanitizeGroupReply(metadata.reply) } };
  }
  if (metadata?.type === 'group-reaction' && typeof metadata.target === 'string' && metadata.target.length <= 96) {
    const emoji = GROUP_REACTIONS.includes(metadata.emoji) ? metadata.emoji : '';
    return { decoded:{ ...message, control:{ type:'reaction', target:metadata.target, emoji } } };
  }
  if (metadata?.type === 'group-delete' && typeof metadata.target === 'string' && metadata.target.length <= 96) {
    return { decoded:{ ...message, control:{ type:'delete', target:metadata.target } } };
  }
  if (metadata?.type !== 'group-attachment' || !metadata.attachmentId) return { decoded:{ ...message, text:plaintext } };
  return { pending:{ message, attachmentId:metadata.attachmentId } };
}

async function decodePrivateGroupAttachment(group, state, message, attachmentId) {
  const encryptedPayload = await downloadPrivateGroupAttachment(state, group, attachmentId, message.id);
  const payload = JSON.parse(await decryptPrivateGroupValue(group.keys?.[message.keyVersion], encryptedPayload));
  if (!['group-image','group-file','group-voice'].includes(payload?.type) || typeof payload.data !== 'string' || payload.data.length > 36 * 1024 * 1024) {
    throw new Error('Invalid group attachment');
  }
  if (payload.type === 'group-file') {
    payload.videoThumb = String(payload.mime || '').startsWith('video/') && safeImageDataUri('image/jpeg', payload.videoThumb)
      ? payload.videoThumb : null;
  }
  const decoded = { ...message, attachmentId, attachment:payload };
  if (payload.type === 'group-image' && message.senderId !== state.accountId && localImageSafetyEnabled()) {
    decoded.imageSafety = await checkLocalImages([payload.data], undefined, { persist:true });
  }
  if (payload.videoThumb && message.senderId !== state.accountId && localImageSafetyEnabled()) {
    decoded.videoSafety = await checkLocalImages([payload.videoThumb], undefined, { persist:true });
    if (decoded.videoSafety !== 'allowed') payload.videoThumb = null;
  }
  return decoded;
}

async function decodePrivateGroupMessage(group, state, message) {
  const { decoded, pending } = await decodePrivateGroupEnvelope(group, message);
  return decoded || decodePrivateGroupAttachment(group, state, pending.message, pending.attachmentId);
}

const PRIVATE_GROUP_ATTACHMENT_CONCURRENCY = 3;

// Text first, then only the attachments somebody still wants: one that was
// deleted, for everyone or just here, is never downloaded (or saved) again.
async function decodePrivateGroupBatch(group, state, messages) {
  const decoded = [], pending = [];
  for (const message of messages) {
    try {
      const result = await decodePrivateGroupEnvelope(group, message);
      if (result.pending) pending.push(result.pending); else decoded.push(result.decoded);
    } catch (_) { decoded.push({ ...message, text:'Encrypted message unavailable on this device.', unavailable:true }); }
  }
  const stubs = [...(group.messages || []), ...decoded, ...pending.map(item => ({ id:item.message.id, senderId:item.message.senderId }))];
  const deleted = privateGroupDeletedIds(stubs, group.hiddenIds || []);
  for (const id of deleted) attachmentCacheDeleteForMessage(privateGroupCacheCode(group.id), id);
  const wanted = pending.filter(item => !deleted.has(item.message.id));
  let next = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const item = wanted[next++];
      try { decoded.push(await decodePrivateGroupAttachment(group, state, item.message, item.attachmentId)); }
      catch (_) { decoded.push({ ...item.message, text:'Encrypted message unavailable on this device.', unavailable:true }); }
    }
  };
  await Promise.all(Array.from({ length:Math.min(PRIVATE_GROUP_ATTACHMENT_CONCURRENCY, wanted.length) }, worker));
  return decoded;
}

async function pollPrivateGroup(render = false, groupId = activePrivateGroupId) {
  const state = loadAccountState(); const group = privateGroups.get(groupId);
  if (!state || !group) return false;
  // With no keys at all nothing can be read. Do not fetch, and above all do
  // not advance the cursor past messages that will be readable once the keys
  // are restored.
  if (!hasPrivateGroupKeys(group)) {
    if (group.id === activePrivateGroupId) renderPrivateGroupMessages(group);
    return false;
  }
  const result = await api('/api/groups/messages', { accountId:state.accountId, sessionToken:state.sessionToken, groupId:group.id, after:group.messageCursor || 0 });
  if (result.error) return false;
  const decoded = await decodePrivateGroupBatch(group, state, result.messages || []);
  const known = new Set((group.messages || []).map(item => item.id));
  const incoming = decoded.filter(item => !known.has(item.id));
  const changed = incoming.length > 0;
  group.messages = [...(group.messages || []), ...incoming].sort((a,b) => a.createdAt - b.createdAt).slice(-200);
  group.messageCursor = Math.max(group.messageCursor || 0, Number(result.cursor) || 0);
  group.updatedAt = group.messages[group.messages.length - 1]?.createdAt || group.updatedAt;
  group.historyHydrated = true;
  if ((render || changed) && group.id === activePrivateGroupId) renderPrivateGroupMessages(group);
  return true;
}

async function sendPrivateGroupMessage() {
  const state = loadAccountState(); const group = privateGroups.get(activePrivateGroupId);
  const input = document.getElementById('group-message-input'); const text = String(input?.value || '').trim();
  if (!state || !group || !text) return;
  if (input.dataset.sending === '1') return;
  if (!window.VaultlixContentSafety) { toast('Safety checks could not load. Reopen Vaultlix before sending.'); return; }
  if (window.VaultlixContentSafety.check(text).blocked) { toast('This text cannot be shared. Edit it and try again.'); return; }
  const key = group.keys?.[group.keyVersion]; if (!key) { toast('Group encryption key is not ready'); return; }
  // Disabling a focused textarea dismisses the software keyboard. Keep it
  // active and use an in-flight marker to prevent duplicate sends instead.
  input.dataset.sending = '1';
  try {
    const messageId = newMsgId();
    // A plain message stays plain text; only a reply needs the wrapper.
    const reply = groupReplyTo ? { ...groupReplyTo } : null;
    const ciphertext = await encryptPrivateGroupValue(key, reply ? { type:'group-text', text, reply } : text);
    const result = await api('/api/groups/send', { accountId:state.accountId, sessionToken:state.sessionToken, groupId:group.id, messageId, ciphertext });
    if (result.error) throw new Error(result.error);
    input.value = ''; updatePrivateGroupComposer(); cancelPrivateGroupReply();
    group.messages = [...(group.messages || []), { id:messageId, senderId:state.accountId, text, reply:reply || undefined, createdAt:result.createdAt, keyVersion:result.keyVersion }];
    group.updatedAt = result.createdAt; renderPrivateGroupMessages(group); renderVaultList();
    input.focus({ preventScroll:true });
  } catch (error) { toast(error.message || 'Message could not be sent'); }
  finally { delete input.dataset.sending; input.focus({ preventScroll:true }); }
}

// Search matches a name or any part of a Private Number (digits only, so
// "24-8059" and "248059" find the same person).
function groupSearchMatches(query, ...fields) {
  const q = String(query || '').trim().toLocaleLowerCase();
  if (!q) return true;
  const digits = q.replace(/\D/g, '');
  return fields.some(field => {
    const text = String(field || '').toLocaleLowerCase();
    return text.includes(q) || (digits.length > 0 && text.replace(/\D/g, '').includes(digits));
  });
}

const GROUP_ICONS = {
  add: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  leave: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  remove: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" y1="11" x2="23" y2="11"/>',
  report: '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
};
function groupIconButton(kind, label, onclick, icon) {
  return `<button class="${kind}" type="button" onclick="${onclick}" aria-label="${label}" title="${label}"><svg viewBox="0 0 24 24" aria-hidden="true">${GROUP_ICONS[icon]}</svg></button>`;
}

function renderGroupMembersList(query = '') {
  const group = privateGroups.get(activePrivateGroupId); const state = loadAccountState(); if (!group || !state) return;
  const owner = group.ownerId === state.accountId;
  const shown = (group.members || []).filter(member => groupSearchMatches(query, member.displayName || 'Vaultlix member', member.privateNumber));
  document.getElementById('group-members-list').innerHTML = shown.length
    ? shown.map(member => `<div class="group-member"><span><strong>${escHtml(member.displayName || 'Vaultlix member')}${member.accountId === state.accountId ? ' · You' : ''}</strong><small>${escHtml(formatPrivateNumber(member.privateNumber))}${member.role === 'owner' ? ' · Owner' : ''}</small></span>${member.accountId !== state.accountId ? `<span>${owner ? `<button type="button" class="icon-btn" onclick="removePrivateGroupMember('${escHtml(member.accountId)}')" aria-label="Remove from group" title="Remove from group"><svg viewBox="0 0 24 24" aria-hidden="true">${GROUP_ICONS.remove}</svg></button>` : ''}<button type="button" class="icon-btn report" onclick="reportPrivateGroupMember('${escHtml(member.accountId)}')" aria-label="Report or block" title="Report or block"><svg viewBox="0 0 24 24" aria-hidden="true">${GROUP_ICONS.report}</svg></button></span>` : ''}</div>`).join('')
    : '<div class="group-chat-empty" style="padding:22px 0">No one in this group matches.</div>';
}

function openGroupMembers() {
  const group = privateGroups.get(activePrivateGroupId); const state = loadAccountState(); if (!group || !state) return;
  const owner = group.ownerId === state.accountId;
  const search = document.getElementById('group-members-search');
  if (search) search.value = '';
  renderGroupMembersList('');
  document.getElementById('group-members-actions').innerHTML = `${owner
    ? groupIconButton('add', 'Add people', 'openAddGroupMembers()', 'add') + groupIconButton('danger', 'Delete group', 'deletePrivateGroup()', 'trash')
    : groupIconButton('danger', 'Leave group', 'leavePrivateGroup()', 'leave')}${groupIconButton('close', 'Close', 'closeGroupMembers()', 'close')}`;
  document.getElementById('group-members').classList.add('open');
}

function closeGroupMembers() { document.getElementById('group-members')?.classList.remove('open'); }

// Contacts the owner could add: securely connected, on this account, and not
// already in the group (matched by the conversation used to wrap their key, or
// by Private Number in case the conversation was re-created).
function groupAddCandidates(group, roomList, accountId) {
  const inGroupRooms = new Set((group.members || []).map(member => member.wrapRoomCode).filter(Boolean));
  const inGroupNumbers = new Set((group.members || []).map(member => String(member.privateNumber || '')).filter(Boolean));
  return roomList.filter(room => room.sharedKey && room.peerPrivateNumber && room.ownerAccountId === accountId
    && !room.reconnectRequired && !inGroupRooms.has(room.code) && !inGroupNumbers.has(String(room.peerPrivateNumber)));
}

function openAddGroupMembers() {
  const group = privateGroups.get(activePrivateGroupId); const state = loadAccountState();
  if (!group || !state || group.ownerId !== state.accountId) return;
  const eligible = groupAddCandidates(group, [...rooms.values()], state.accountId);
  const room = 49 - Math.max(0, (group.members?.length || 1) - 1);
  document.getElementById('group-add-list').innerHTML = eligible.length
    ? eligible.map(entry => `<label class="group-contact" data-search-name="${escHtml(roomDisplayLabel(entry))}" data-search-number="${escHtml(String(entry.peerPrivateNumber))}"><input type="checkbox" value="${escHtml(entry.code)}"><span>${escHtml(roomDisplayLabel(entry))}<small>${escHtml(formatPrivateNumber(entry.peerPrivateNumber))}</small></span></label>`).join('')
    : '<div class="group-chat-empty" style="padding:24px">Everyone you are connected with is already in this group.</div>';
  document.getElementById('group-add-note').textContent = room <= 0
    ? 'This group is full.'
    : 'New people can read messages sent after they join, not earlier ones.';
  document.getElementById('group-add-submit').disabled = !eligible.length || room <= 0;
  const search = document.getElementById('group-add-search');
  if (search) { search.value = ''; search.hidden = !eligible.length; }
  filterGroupAddList('');
  document.getElementById('group-add-overlay').classList.add('open');
}

// Hides rows instead of rebuilding them, so people already ticked stay ticked
// while the list is narrowed.
function filterGroupAddList(query) {
  let visible = 0;
  const rows = document.querySelectorAll('#group-add-list .group-contact');
  rows.forEach(row => {
    const match = groupSearchMatches(query, row.dataset.searchName, row.dataset.searchNumber);
    row.hidden = !match;
    if (match) visible++;
  });
  const empty = document.getElementById('group-add-empty');
  if (empty) empty.hidden = !rows.length || visible !== 0;
}

function closeAddGroupMembers() { document.getElementById('group-add-overlay')?.classList.remove('open'); }

async function addPrivateGroupMembers() {
  const group = privateGroups.get(activePrivateGroupId); const state = loadAccountState();
  if (!group || !state || group.ownerId !== state.accountId) return;
  const codes = [...document.querySelectorAll('#group-add-list input:checked')].map(input => input.value);
  if (!codes.length) { toast('Select at least one contact'); return; }
  const button = document.getElementById('group-add-submit');
  button.disabled = true; button.textContent = 'Adding…';
  try {
    await rotatePrivateGroupKey(group, null, codes);
    closeAddGroupMembers(); closeGroupMembers(); openGroupMembers();
    document.getElementById('group-chat-sub').textContent = `${group.members?.length || 1} members · end-to-end encrypted`;
    toast(codes.length === 1 ? 'Person added to the group' : `${codes.length} people added to the group`);
  } catch (error) { toast(error.message || 'People could not be added'); }
  finally { button.disabled = false; button.textContent = 'Add to group'; }
}

async function rotatePrivateGroupKey(group, removedAccountId = null, addRoomCodes = []) {
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
  // New people get the new key wrapped for them on their own conversation
  // with the owner, exactly like the founding members did at creation.
  const additions = [];
  for (const code of addRoomCodes) {
    const room = rooms.get(code);
    if (!room?.sharedKey) throw new Error('One contact is not securely connected yet');
    const wrappedKey = await encryptMsg(room, JSON.stringify({ type:'private-group-key', groupKeyId:group.keyBinding, version:nextVersion, key:encodedKey }));
    additions.push({ roomCode:code, wrappedKey });
  }
  const result = additions.length
    ? await api('/api/groups/add-members', { accountId:state.accountId, sessionToken:state.sessionToken,
        groupId:group.id, encryptedName, envelopes, additions })
    : await api('/api/groups/rekey', { accountId:state.accountId, sessionToken:state.sessionToken,
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
      forgetPrivateGroupDownloads(group.id); privateGroups.delete(group.id); savePrivateGroupSessions(); scheduleAccountSync(); closeGroupMembers(); closePrivateGroup();
    }
  } catch (error) { console.error('Group safety exit failed', error); }
  toast('Report sent and member blocked');
}

async function leavePrivateGroup() {
  const state = loadAccountState(); const group = privateGroups.get(activePrivateGroupId);
  if (!state || !group || !confirm('Leave this private group?')) return;
  const result = await api('/api/groups/leave', { accountId:state.accountId, sessionToken:state.sessionToken, groupId:group.id });
  if (result.error) { toast(result.error); return; }
  forgetPrivateGroupDownloads(group.id); privateGroups.delete(group.id); savePrivateGroupSessions(); scheduleAccountSync(); closeGroupMembers(); closePrivateGroup(); toast('You left the group');
}

async function deletePrivateGroup() {
  const state = loadAccountState(); const group = privateGroups.get(activePrivateGroupId);
  if (!state || !group || !confirm('Delete this private group for every member?')) return;
  const result = await api('/api/groups/delete', { accountId:state.accountId, sessionToken:state.sessionToken, groupId:group.id });
  if (result.error) { toast(result.error); return; }
  forgetPrivateGroupDownloads(group.id); privateGroups.delete(group.id); savePrivateGroupSessions(); scheduleAccountSync(); closeGroupMembers(); closePrivateGroup(); toast('Private group deleted');
}
