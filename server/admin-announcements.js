'use strict';

const TITLE_MAX = 60;
const BODY_MAX = 180;
const PLATFORMS = new Set(['all', 'ios', 'android']);
const AUDIENCES = new Set(['test', 'all']);

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

function buildAnnouncementPayload({ title, body }) {
  return {
    title,
    body,
    announcement:true,
    tag:`vaultlix-update-${Date.now()}`,
  };
}

module.exports = {
  TITLE_MAX,
  BODY_MAX,
  validateAnnouncement,
  selectAnnouncementTargets,
  buildAnnouncementPayload,
};
