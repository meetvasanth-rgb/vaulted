'use strict';

const TITLE_MAX = 60;
const BODY_MAX = 180;
const PLATFORMS = new Set(['all', 'ios', 'android']);
const AUDIENCES = new Set(['test', 'all']);
const ANNOUNCEMENT_THUMBNAIL_URL = 'https://vaultlix.com/icons/icon-192.png';
const THUMBNAIL_MAX_BYTES = 600 * 1024;
const MEDIA_MAX_BYTES = 8 * 1024 * 1024;
const EXPIRY_MIN_HOURS = 1;
const EXPIRY_MAX_HOURS = 168;

function cleanText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function validateAnnouncement(input = {}) {
  const title = cleanText(input.title);
  const body = cleanText(input.body);
  const platform = PLATFORMS.has(input.platform) ? input.platform : '';
  const audience = AUDIENCES.has(input.audience) ? input.audience : '';
  if (!title || title.length > TITLE_MAX) return { error:`Enter a title between 1 and ${TITLE_MAX} characters.` };
  if (!body || body.length > BODY_MAX) return { error:`Enter a message between 1 and ${BODY_MAX} characters.` };
  if (!platform) return { error:'Choose iOS, Android or both platforms.' };
  if (!audience) return { error:'Choose test accounts or all opted-in users.' };
  if (audience === 'all' && input.confirmAll !== true) return { error:'Confirm the all-user broadcast before sending.' };
  return { value:{ title, body, platform, audience } };
}

function selectAnnouncementTargets(accounts, { platform, audience }) {
  const targets = [];
  const seen = new Set();
  for (const [accountId, account] of accounts) {
    if (audience === 'test' && !account?.isTestAccount) continue;
    for (const destination of account?.pushDestinations || []) {
      if (!destination || !['ios', 'android'].includes(destination.platform)) continue;
      if (platform !== 'all' && destination.platform !== platform) continue;
      const token = destination.platform === 'ios' ? destination.apnsToken : destination.fcmToken;
      if (!token) continue;
      const key = `${destination.platform}:${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ accountId, destination });
    }
  }
  return targets;
}

function decodeAnnouncementThumbnail(value) {
  if (value === undefined || value === null || value === '') return { value:null };
  if (typeof value !== 'string' || value.length > Math.ceil(THUMBNAIL_MAX_BYTES * 4 / 3) + 64) {
    return { error:'Choose a thumbnail smaller than 600 KB.' };
  }
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return { error:'Choose a JPEG, PNG or WebP thumbnail.' };
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > THUMBNAIL_MAX_BYTES) return { error:'Choose a thumbnail smaller than 600 KB.' };
  return { value:bytes };
}

function decodeAnnouncementMedia(value) {
  if (value === undefined || value === null || value === '') return { value:null };
  if (typeof value !== 'string' || value.length > Math.ceil(MEDIA_MAX_BYTES * 4 / 3) + 128) {
    return { error:'Choose an update image or video smaller than 8 MB.' };
  }
  const match = /^data:(image\/(?:jpeg|png|webp)|video\/mp4);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return { error:'Choose a JPEG, PNG, WebP or MP4 update.' };
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MEDIA_MAX_BYTES) return { error:'Choose an update image or video smaller than 8 MB.' };
  return { value:{ bytes, contentType:match[1], kind:match[1].startsWith('video/') ? 'video' : 'image' } };
}

function validateAnnouncementExperience(input = {}) {
  const expiryHours = Number(input.expiryHours ?? 12);
  if (!Number.isInteger(expiryHours) || expiryHours < EXPIRY_MIN_HOURS || expiryHours > EXPIRY_MAX_HOURS) return { error:'Choose an expiry from 1 to 168 hours.' };
  return { value:{ viewOnce:input.viewOnce !== false, expiryHours } };
}

function trustedThumbnailUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'vaultlix.com' &&
      (url.pathname === '/icons/icon-192.png' || url.pathname === '/api/announcement-thumbnail');
  } catch (_) { return false; }
}

function buildAnnouncementPayload({ id, title, body, thumbnailUrl, viewOnce, expiresAt }) {
  return {
    title,
    body,
    announcement:true,
    updateId:id || '',
    viewOnce:viewOnce !== false,
    expiresAt:Number(expiresAt) || 0,
    thumbnailUrl:trustedThumbnailUrl(thumbnailUrl) ? thumbnailUrl : ANNOUNCEMENT_THUMBNAIL_URL,
    tag:`vaultlix-update-${Date.now()}`,
  };
}

module.exports = {
  TITLE_MAX,
  BODY_MAX,
  ANNOUNCEMENT_THUMBNAIL_URL,
  THUMBNAIL_MAX_BYTES,
  MEDIA_MAX_BYTES,
  EXPIRY_MIN_HOURS,
  EXPIRY_MAX_HOURS,
  decodeAnnouncementThumbnail,
  decodeAnnouncementMedia,
  validateAnnouncementExperience,
  validateAnnouncement,
  selectAnnouncementTargets,
  buildAnnouncementPayload,
};
