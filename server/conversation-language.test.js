'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const translationStart = client.indexOf('const VAULTLIX_LANGUAGES');
const translationEnd = client.indexOf('\nfunction normalizeVaultlixLanguage', translationStart);
const context = {};

vm.runInNewContext(
  `${client.slice(translationStart, translationEnd)}\nthis.languages = VAULTLIX_LANGUAGES; this.translations = VAULTLIX_TRANSLATIONS;`,
  context
);

const requiredConversationKeys = [
  'conversation_actions', 'open_conversation_menu', 'conversation_settings', 'achievements',
  'quick_lock', 'clear_chat', 'leave_conversation', 'delete_conversation',
  'current_conversation_safety', 'block_participant', 'report_and_block',
  'participant_private_number', 'private_number_unavailable', 'copy_number', 'share_number',
  'label_conversation', 'edit_conversation_label', 'conversation_label_subtitle',
  'keep_conversation_question', 'keep_conversation_subtitle', 'keep_conversation', 'not_now',
  'persistent_conversation', 'conversation_stays_available', 'revoke_get_new_link',
  'current_link_stops', 'open_conversation_to_manage', 'report_privacy_explanation',
  'reason', 'spam_or_scam', 'harassment_or_bullying', 'threats_or_violence',
  'sexual_or_exploitative_content', 'suspected_illegal_activity', 'other',
  'optional_report_details', 'report_message_consent', 'report_review_note',
  'achievement_intro', 'messages', 'connection', 'connection_sparks', 'secure_calls',
  'shared_moments', 'earned', 'first_mutual_conversation', 'days_connected',
  'one_year_connected', 'day_spark', 'first_secure_call', 'call_minutes', 'call_hours',
  'first_video_call', 'video_calls', 'first_voice_note', 'voice_notes',
  'first_media_share', 'media_shares'
];

test('every supported language covers the one-to-one conversation menu and submenus', () => {
  assert.deepEqual(Array.from(context.languages), ['en', 'zh', 'ru', 'hi', 'ar', 'hy']);
  for (const language of context.languages) {
    for (const key of requiredConversationKeys) {
      assert.equal(typeof context.translations[language][key], 'string', `${language}.${key} is missing`);
      assert.ok(context.translations[language][key].trim(), `${language}.${key} is empty`);
    }
  }
});

test('Hindi conversation strings do not silently fall back to English', () => {
  for (const key of requiredConversationKeys) {
    assert.notEqual(context.translations.hi[key], context.translations.en[key], `Hindi still uses English for ${key}`);
  }
});

test('conversation menu and settings controls opt into live language updates', () => {
  const menu = client.slice(client.indexOf('id="conversation-menu-btn"'), client.indexOf('<button class="cross-vault-banner"'));
  const settings = client.slice(client.indexOf('id="settings-room-section"'), client.indexOf('id="settings-about-section"'));

  for (const key of ['conversation_settings', 'achievements', 'quick_lock', 'clear_chat', 'leave_conversation', 'delete_conversation']) {
    assert.match(menu, new RegExp(`data-i18n="${key}"`));
  }
  for (const key of ['participant_private_number', 'copy_number', 'share_number', 'conversation_label_subtitle', 'keep_conversation_question', 'persistent_conversation', 'revoke_get_new_link', 'open_conversation_to_manage']) {
    assert.match(settings, new RegExp(`data-i18n="${key}"`));
  }
  assert.match(client, /querySelectorAll\('\[data-i18n-title\]'\)/);
  assert.match(client, /querySelectorAll\('\[data-i18n-aria-label\]'\)/);
});

test('dynamic conversation submenu text uses translations', () => {
  assert.match(client, /function i18nFormat\(key, values = \{\}\)/);
  assert.match(client, /achievementGroupHtml\(i18n\('messages'\)/);
  assert.match(client, /name:i18n\('first_secure_call'\)/);
  assert.match(client, /i18nFormat\('connected_since', \{date:since\}\)/);
  assert.match(client, /i18n\('waiting_to_join'\)/);
});
