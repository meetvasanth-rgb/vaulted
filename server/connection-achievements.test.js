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
  assert.match(client, /const colors = \['#FF3B6B','#FFB800','#33D17A','#2EC5FF','#8B5CF6','#FF70C9','#FFFFFF'\]/);
});

test('achievements animate as transient text without a share card', () => {
  assert.match(client, /id="achievement-celebration"[^>]*role="status"/);
  assert.match(client, /showAchievementCelebration\(MILESTONE_DEFS\[id\]\)/);
  assert.match(client, /achievementCelebrationTimer = setTimeout[\s\S]{0,100}3600/);
  assert.doesNotMatch(client, /id="milestone-canvas"|shareMilestoneCard|milestone-share-btn/);
});

test('each direct conversation exposes earned badges and upcoming progress', () => {
  assert.match(client, /onclick="openConversationAchievements\(\)"[\s\S]{0,300}<span>Achievements<\/span>/);
  assert.match(client, /id="achievements-overlay"[^>]*role="dialog"/);
  assert.match(client, /300 messages[\s\S]*500 messages[\s\S]*1,000 messages/);
  assert.match(client, /First secure call[\s\S]*60 call minutes[\s\S]*5 call hours[\s\S]*25 call hours/);
  assert.match(client, /First video call[\s\S]*10 video calls/);
  assert.match(client, /First voice note[\s\S]*100 voice notes[\s\S]*First media share[\s\S]*100 media shares/);
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

test('every achievement uses a readable badge and every celebration uses multicolour fireworks', () => {
  assert.match(client, /\.achievement-kicker\{color:#fff/);
  assert.match(client, /\.achievement-title\{[^}]*background:rgba\(8,8,12,\.66\)[^}]*color:#fff/);
  assert.match(client, /\.achievement-badge-card\.earned\{[^}]*#FFF6F9/);
  assert.match(client, /\.achievement-badge-card\.earned \.achievement-badge-icon\{[^}]*#8A3A58[^}]*#682C43/);
  assert.match(client, /const colors = \['#FF3B6B','#FFB800','#33D17A','#2EC5FF','#8B5CF6','#FF70C9','#FFFFFF'\]/);
  assert.doesNotMatch(client, /first_call:\{[^}]*☎|First secure call',icon:'☎'/);
  const achievementCss = client.slice(client.indexOf('/* ── CONNECTION ACHIEVEMENTS'), client.indexOf('.number-card-overlay'));
  assert.doesNotMatch(achievementCss, /#F3C66B|#F7E8C7|#D8B25D|#F4D680|#D8A33E|#D4A541/);
});
