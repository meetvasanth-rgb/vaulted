# Vaultlix Android prototype

This first milestone packages the production Vaultlix web application in a
Capacitor Android shell. It intentionally leaves the original repository in
`Downloads` untouched.

## Prototype defaults

- App name: Vaultlix
- Application ID: `com.vaultlix.app`
- Minimum supported Android version: Android 9 (API 28)
- Production origin: `https://vaultlix.com`
- Cleartext traffic: disabled
- Android backup of WebView storage: disabled
- Vault invitation links: restricted to `https://vaultlix.com/join/*`

## Important boundary

This milestone validates installation, WebRTC permissions, calls, and deep
links. Reliable incoming calls while the process is backgrounded will require
native FCM handling and a foreground call service in the next milestone.

## Build

```bash
npm install
npm run android:add
npm run android:sync
npm run android:build:debug
```

The debug APK is produced at:

`android/app/build/outputs/apk/debug/app-debug.apk`
