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
  assert.match(client, /localStorage\.getItem\(CELEBRATION_DAY_KEY\) === today/);
});

test('achievements animate as transient text without a share card', () => {
  assert.match(client, /id="achievement-celebration"[^>]*role="status"/);
  assert.match(client, /showAchievementCelebration\(MILESTONE_DEFS\[id\]\)/);
  assert.match(client, /achievementCelebrationTimer = setTimeout[\s\S]{0,100}3600/);
  assert.doesNotMatch(client, /id="milestone-canvas"|shareMilestoneCard|milestone-share-btn/);
});
