package com.vaultlix.app;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Keyguard-safe presentation for the single native Android WebRTC engine. */
public class NativeCallActivity extends Activity implements NativeWebRtcCallEngine.Listener {
    static final String EXTRA_CALLER = "caller";
    static final String EXTRA_ROOM_CODE = "roomCode";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private NativeWebRtcCallEngine engine;
    private TextView status;
    private long connectedAt;
    private boolean muted;
    private boolean speaker;
    private AudioManager audioManager;
    private String roomCode;
    private boolean finishingCall;
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (connectedAt == 0 || status == null) return;
            long seconds = Math.max(0, (System.currentTimeMillis() - connectedAt) / 1000);
            status.setText(String.format(java.util.Locale.US, "%02d:%02d", seconds / 60, seconds % 60));
            handler.postDelayed(this, 1000);
        }
    };

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        setShowWhenLocked(true); setTurnScreenOn(true);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        roomCode = getIntent().getStringExtra(EXTRA_ROOM_CODE);
        engine = NativeWebRtcCallEngine.get(this);
        engine.addListener(this);
        audioManager = getSystemService(AudioManager.class);
        configureAudio(false);
        buildUi(getIntent().getStringExtra(EXTRA_CALLER));
    }

    private void buildUi(String caller) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL); root.setGravity(Gravity.CENTER);
        root.setPadding(dp(26), dp(38), dp(26), dp(38)); root.setBackgroundColor(Color.rgb(39,29,37));
        TextView brand = label("V A U L T L I X", 17, Color.rgb(200,117,136)); root.addView(brand);
        TextView name = label(caller == null || caller.trim().isEmpty() ? getString(R.string.native_private_call) : caller.trim(), 34, Color.WHITE);
        name.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        LinearLayout.LayoutParams np = new LinearLayout.LayoutParams(-2,-2); np.setMargins(0,dp(72),0,dp(14)); root.addView(name,np);
        status = label(getString(R.string.native_connecting_securely), 21, Color.rgb(248,241,234)); root.addView(status);
        TextView secure = label(getString(R.string.native_encrypted_relayed), 14, Color.rgb(180,170,176));
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(-2,-2); sp.setMargins(0,dp(12),0,dp(84)); root.addView(secure,sp);
        LinearLayout actions = new LinearLayout(this); actions.setGravity(Gravity.CENTER);
        Button mute = button(getString(R.string.native_mute)); mute.setOnClickListener(v -> { muted=!muted; engine.setMuted(muted); mute.setText(muted?R.string.native_unmute:R.string.native_mute); });
        Button route = button(getString(R.string.native_speaker)); route.setOnClickListener(v -> { speaker=!speaker; configureAudio(speaker); route.setText(speaker?R.string.native_phone:R.string.native_speaker); });
        Button end = button(getString(R.string.native_end)); end.setTextColor(Color.WHITE); end.setBackgroundColor(Color.rgb(185,79,99));
        end.setOnClickListener(v -> { engine.end(true); finishCall(); });
        actions.addView(mute, actionParams()); actions.addView(route, actionParams()); actions.addView(end, actionParams()); root.addView(actions);
        setContentView(root);
    }

    @Override public void onState(String value) { runOnUiThread(() -> { if (connectedAt == 0 && status != null) status.setText(R.string.native_connecting_securely); }); }
    @Override public void onConnected() { runOnUiThread(() -> { if (connectedAt != 0) return; connectedAt=System.currentTimeMillis(); getWindow().getDecorView().performHapticFeedback(HapticFeedbackConstants.CONFIRM); tick.run(); }); }
    @Override public void onEnded(String reason) { runOnUiThread(this::finishCall); }

    private void finishCall() {
        if (finishingCall) return;
        finishingCall = true;
        handler.removeCallbacks(tick);
        String history = connectedAt == 0 ? "" : getString(R.string.native_encrypted_call_duration, formatDuration((System.currentTimeMillis()-connectedAt)/1000));
        MainActivity.notifyDedicatedCallEnded(roomCode, history);
        finish(); overridePendingTransition(0,0);
    }

    @Override protected void onDestroy() { handler.removeCallbacks(tick); if (engine != null) engine.removeListener(this); restoreAudio(); super.onDestroy(); }

    @SuppressWarnings("deprecation") private void configureAudio(boolean useSpeaker) {
        if (audioManager == null) return; audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            for (AudioDeviceInfo device : audioManager.getAvailableCommunicationDevices()) {
                int desired = useSpeaker ? AudioDeviceInfo.TYPE_BUILTIN_SPEAKER : AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
                if (device.getType() == desired) { audioManager.setCommunicationDevice(device); break; }
            }
        } else audioManager.setSpeakerphoneOn(useSpeaker);
    }
    @SuppressWarnings("deprecation") private void restoreAudio() { if (audioManager != null) { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) audioManager.clearCommunicationDevice(); else audioManager.setSpeakerphoneOn(false); audioManager.setMode(AudioManager.MODE_NORMAL); } }
    private TextView label(String value,int size,int color){ TextView v=new TextView(this);v.setText(value);v.setTextSize(size);v.setTextColor(color);v.setGravity(Gravity.CENTER);return v; }
    private Button button(String value){ Button b=new Button(this);b.setText(value);b.setTextColor(Color.rgb(248,241,234));b.setBackgroundColor(Color.rgb(104,44,67));return b; }
    private LinearLayout.LayoutParams actionParams(){ LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(0,dp(58),1);p.setMargins(dp(5),0,dp(5),0);return p; }
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
    private String formatDuration(long value){return String.format(java.util.Locale.US,"%02d:%02d",value/60,value%60);}
}
