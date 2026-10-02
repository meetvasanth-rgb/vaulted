const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

function extractedSparkFunction() {
  const start = client.indexOf('function connectionSparkFromDays');
  const end = client.indexOf('function pruneAchievementDays', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const context = { achievementDayNumber:() => 100, result:null };
  vm.runInNewContext(`${client.slice(start, end)}\nresult = connectionSparkFromDays;`, context);
  return context.result;
}

test('Connection Sparks require reciprocal activity and allow one grace day', () => {
  const spark = extractedSparkFunction();
  assert.equal(spark({ 98:{me:true,peer:true}, 99:{me:true,peer:true}, 100:{me:true,peer:true} }, 100), 3);
  assert.equal(spark({ 98:{me:true,peer:true}, 99:{me:true,peer:true} }, 100), 2);
  assert.equal(spark({ 98:{me:true,peer:true} }, 100), 0);
  assert.equal(spark({ 99:{me:true,peer:true}, 100:{me:true,peer:false} }, 100), 1);
});

test('achievement state is separate from room keys and follows encrypted account backup', () => {
  assert.match(client, /const ACHIEVEMENT_STATE_KEY = 'vaultlix_achievement_state_v1'/);
  assert.match(client, /achievements:achievementBundleSnapshot\(accountId\)/);
  assert.match(client, /mergeAchievementBundle\(bundle\.achievements, accountId\)/);
  assert.doesNotMatch(client, /function saveAchievementState[\s\S]{0,350}persistRoom\(/);
});

test('completed calls, video, inbox badges and accessible motion are wired to achievements', () => {
  assert.match(client, /if \(wasActive\) recordCallAchievement\(room, duration, wasVideoCall\)/);
  assert.match(client, /room\.callHadVideo = true/);
  assert.match(client, /connectionSpark >= 3[\s\S]{0,180}connection-spark/);
  assert.match(client, /prefers-reduced-motion:reduce/);
  // The celebration's spring-in, glow bloom and shine sweep all fall back to
  // an instant, static reveal under reduced motion — no confetti canvas to
  // gate any more.
  assert.match(client, /prefers-reduced-motion:reduce\)\{\.achievement-celebration\{transition:opacity \.15s ease\}[\s\S]{0,220}\.achievement-badge-glow,\.achievement-badge-shine\{display:none\}\}/);
});

test('achievements animate as a poised, badge-first moment without a share card', () => {
  assert.match(client, /id="achievement-celebration"[^>]*role="status"/);
  assert.match(client, /showAchievementCelebration\(MILESTONE_DEFS\[id\]\)/);
  assert.match(client, /achievementCelebrationTimer = setTimeout\(dismiss, 2600\)/);
  // Tapping the moment away early is as valid as waiting it out.
  assert.match(client, /ceremony\.onclick = \(\) => \{ clearTimeout\(achievementCelebrationTimer\); dismiss\(\); \}/);
  // The badge medallion reuses the exact gradient an earned achievement-badge-icon
  // uses in the achievements list — the celebration shows the real badge, not a
  // disconnected graphic — and carries the milestone's own glyph/number, so the
  // title only needs to confirm what it is rather than repeat the value.
  assert.match(client, /\.achievement-badge-medal\{[^}]*background:linear-gradient\(145deg,#8A3A58,#682C43\)/);
  assert.match(client, /icon\.textContent = String\(milestone\.value \?\? '✦'\)\.slice\(0, 4\)/);
  assert.doesNotMatch(client, /id="milestone-canvas"|shareMilestoneCard|milestone-share-btn/);
});

test('each direct conversation exposes earned badges and upcoming progress', () => {
  assert.match(client, /onclick="openConversationAchievements\(\)"[\s\S]{0,300}<span data-i18n="achievements">Achievements<\/span>/);
  assert.match(client, /id="achievements-overlay"[^>]*role="dialog"/);
  assert.match(client, /name:`300 \$\{i18n\('messages_unit'\)\}`[\s\S]*name:`500 \$\{i18n\('messages_unit'\)\}`[\s\S]*name:`1,000 \$\{i18n\('messages_unit'\)\}`/);
  assert.match(client, /name:i18n\('first_secure_call'\)[\s\S]*i18nFormat\('call_minutes',[\s\S]*i18nFormat\('call_hours'/);
  assert.match(client, /name:i18n\('first_video_call'\)[\s\S]*i18nFormat\('video_calls'/);
  assert.match(client, /name:i18n\('first_voice_note'\)[\s\S]*i18nFormat\('voice_notes'[\s\S]*name:i18n\('first_media_share'\)[\s\S]*i18nFormat\('media_shares'/);
  assert.match(client, /achievement-badge-card\$\{achieved \? ' earned' : ''\}/);
});

test('text, voice and media achievements keep independent encrypted counters', () => {
  assert.match(client, /\['countedTextIds','text',1100\]/);
  assert.match(client, /\['countedVoiceIds','voice',150\]/);
  assert.match(client, /\['countedMediaIds','media',150\]/);
  assert.match(client, /const messages = Number\(ledger\.textCount\) \|\| 0/);
  assert.match(client, /ledger\.callCount = \(Number\(ledger\.callCount\) \|\| 0\) \+ 1/);
  assert.match(client, /if \(wasVideo\) ledger\.videoCallCount =/);
});

test('every achievement uses a readable badge and the celebration is a poised badge reveal, not fireworks', () => {
  assert.match(client, /\.achievement-kicker\{[^}]*color:rgba\(255,255,255,\.7\)/);
  assert.match(client, /\.achievement-title\{[^}]*color:#fff/);
  assert.match(client, /\.achievement-badge-card\.earned\{[^}]*#FFF6F9/);
  assert.match(client, /\.achievement-badge-card\.earned \.achievement-badge-icon\{[^}]*#8A3A58[^}]*#682C43/);
  // No confetti canvas, no rainbow particle palette, anywhere.
  assert.doesNotMatch(client, /celebration-fireworks|launchCelebrationFireworks/);
  assert.doesNotMatch(client, /#FF3B6B','#FFB800','#33D17A','#2EC5FF','#8B5CF6','#FF70C9'/);
  assert.doesNotMatch(client, /first_call:\{[^}]*☎|First secure call',icon:'☎'/);
  const achievementCss = client.slice(client.indexOf('/* ── CONNECTION ACHIEVEMENTS'), client.indexOf('.number-card-overlay'));
  assert.doesNotMatch(achievementCss, /#F3C66B|#F7E8C7|#D8B25D|#F4D680|#D8A33E|#D4A541/);
  // The spring-in uses the same overshoot curve already established
  // elsewhere in the app's own motion language, not an arbitrary new one.
  assert.match(achievementCss, /achievement-medal-in \.62s cubic-bezier\(\.34,1\.56,\.64,1\) forwards/);
});
