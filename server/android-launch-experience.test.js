const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'mobile/android/app/src/main/java/com/vaultlix/app/MainActivity.java'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'mobile/android/app/src/main/res/values/styles.xml'), 'utf8');
const client = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');

test('Android hands its branded system splash directly to a native launch cover', () => {
  assert.match(styles, /windowSplashScreenBackground">#FBF7F8/);
  assert.match(styles, /windowSplashScreenAnimatedIcon">@mipmap\/ic_launcher/);
  assert.match(styles, /postSplashScreenTheme">@style\/AppTheme\.NoActionBar/);
  assert.match(main, /SplashScreen\.installSplashScreen\(this\)/);
  assert.match(main, /setKeepOnScreenCondition\(\(\) -> !launchCoverAttached\)/);
  assert.ok(main.indexOf('showLaunchCover();') > main.indexOf('super.onCreate(savedInstanceState);'));
  assert.match(main, /new int\[\] \{ Color\.rgb\(251, 247, 248\), Color\.rgb\(247, 238, 241\) \}/);
  assert.match(main, /wordmark\.setText\("Vaultlix"\)/);
});

test('the web app removes the native cover only after its first real screen can paint', () => {
  assert.match(main, /public void hideLaunchCover\(\)[\s\S]{0,160}runOnUiThread\(MainActivity\.this::hideLaunchCover\)/);
  assert.match(client, /requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => \{[\s\S]{0,180}VaultlixAndroid\?\.hideLaunchCover/);
  assert.match(main, /cover\.postDelayed\(this::hideLaunchCover, 12_000L\)/);
  assert.match(main, /document\.querySelector\('\.screen\.active'\)/);
  assert.match(main, /o\.classList\.contains\('leaving'\)/);
  assert.match(main, /launchCoverHandler\.postDelayed\(checkWebLaunchReady, 80L\)/);
});
