package com.vaultlix.app;

import android.content.Context;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.AudioSource;
import org.webrtc.AudioTrack;
import org.webrtc.DataChannel;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpReceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.audio.JavaAudioDeviceModule;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/** Native, audio-only, forced-TURN WebRTC engine shared by Android call UI. */
final class NativeWebRtcCallEngine {
    interface Listener {
        void onState(String state);
        void onConnected();
        void onEnded(String reason);
    }

    private static final String TAG = "VXCALL";
    private static NativeWebRtcCallEngine instance;

    static synchronized NativeWebRtcCallEngine get(Context context) {
        if (instance == null) instance = new NativeWebRtcCallEngine(context.getApplicationContext());
        return instance;
    }

    private final Context context;
    private final NativeCallRoomStore roomStore;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();
    private final OkHttpClient http = new OkHttpClient.Builder().retryOnConnectionFailure(true).build();
    private final PeerConnectionFactory factory;
    private final SecureRandom random = new SecureRandom();
    private final ArrayDeque<JSONObject> queuedSignals = new ArrayDeque<>();
    private final List<IceCandidate> pendingIce = new ArrayList<>();
    private NativeCallRoomStore.Room room;
    private WebSocket socket;
    private PeerConnection peer;
    private AudioSource audioSource;
    private AudioTrack audioTrack;
    private final CopyOnWriteArraySet<Listener> listeners = new CopyOnWriteArraySet<>();
    private boolean signalingReady;
    private boolean outgoing;
    private boolean answered;
    private boolean offerReceived;
    private int sequenceOut;
    private int sequenceIn;
    private String peerSessionId;
    private final String sessionId = UUID.randomUUID().toString();
    private String callerName = "Someone";
    private volatile String currentRoomCode = "";
    private int generation;

    private NativeWebRtcCallEngine(Context context) {
        this.context = context;
        roomStore = new NativeCallRoomStore(context);
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions());
        JavaAudioDeviceModule adm = JavaAudioDeviceModule.builder(context).createAudioDeviceModule();
        factory = PeerConnectionFactory.builder().setAudioDeviceModule(adm).createPeerConnectionFactory();
        adm.release();
    }

    void addListener(Listener listener) { if (listener != null) listeners.add(listener); }
    void removeListener(Listener listener) { listeners.remove(listener); }
    String currentRoomCode() { return currentRoomCode; }

    boolean prepareIncoming(String code) {
        NativeCallRoomStore.Room saved = roomStore.byCode(code);
        if (saved == null) return false;
        executor.execute(() -> prepare(saved, false, "Someone"));
        return true;
    }

    boolean prepareOutgoing(String handle, String caller) {
        NativeCallRoomStore.Room saved = roomStore.byHandle(handle);
        if (saved == null) return false;
        executor.execute(() -> {
            prepare(saved, true, caller);
            sendInvite();
            scheduleInviteRetry(generation, 9);
        });
        return true;
    }

    void answer() {
        executor.execute(() -> {
            if (room == null || outgoing) return;
            answered = true;
            if (audioTrack != null) audioTrack.setEnabled(true);
            sendSignal("call-accept", new JSONObject());
            notifyState("connecting");
            scheduleAcceptRetry(generation, 12);
        });
    }

    void setMuted(boolean muted) { executor.execute(() -> { if (audioTrack != null) audioTrack.setEnabled(!muted); }); }

    void end(boolean notifyPeer) {
        executor.execute(() -> {
            if (notifyPeer) sendSignal("call-hangup", new JSONObject());
            reset("ended");
        });
    }

    private void prepare(NativeCallRoomStore.Room saved, boolean isOutgoing, String caller) {
        reset(null);
        room = saved;
        currentRoomCode = saved.code;
        outgoing = isOutgoing;
        callerName = caller == null ? "Someone" : caller;
        int run = generation;
        connectSocket(run);
        fetchTurn(run);
        notifyState(isOutgoing ? "calling" : "ringing");
    }

    private void connectSocket(int run) {
        Request request = new Request.Builder().url("wss://vaultlix.com/ws/signal").build();
        socket = http.newWebSocket(request, new WebSocketListener() {
            @Override public void onOpen(WebSocket webSocket, Response response) {
                executor.execute(() -> {
                    if (run != generation || socket != webSocket || room == null) return;
                    JSONObject auth = new JSONObject();
                    try { auth.put("type", "auth").put("code", room.code).put("token", room.token).put("nativeCall", true); } catch (Exception ignored) {}
                    webSocket.send(auth.toString());
                });
            }
            @Override public void onMessage(WebSocket webSocket, String text) { executor.execute(() -> handleSocket(run, text)); }
            @Override public void onFailure(WebSocket webSocket, Throwable error, Response response) {
                executor.execute(() -> { if (run == generation && room != null) reconnect(run, 1); });
            }
        });
    }

    private void reconnect(int run, int attempt) {
        if (run != generation || room == null || attempt > 6) return;
        signalingReady = false;
        scheduler.schedule(() -> executor.execute(() -> {
            if (run == generation && room != null) connectSocket(run);
        }), Math.min(4000, 250L << Math.min(attempt, 4)), TimeUnit.MILLISECONDS);
    }

    private void handleSocket(int run, String text) {
        if (run != generation || room == null) return;
        try {
            JSONObject wire = new JSONObject(text);
            String type = wire.optString("type");
            if ("ready".equals(type)) { signalingReady = true; flushSignals(); return; }
            if ("native-call-declined".equals(type)) { reset("declined"); return; }
            if ("native-call-answering".equals(type)) { notifyState("connecting"); return; }
            String remoteSession = wire.optString("sessionId");
            if (!remoteSession.isEmpty() && !remoteSession.equals(peerSessionId)) { peerSessionId = remoteSession; sequenceIn = 0; }
            JSONObject payload = decrypt(wire.optString("envelope"));
            if (payload == null) return;
            switch (type) {
                case "call-invite":
                    if (!outgoing) { sendSignal("call-ringing", new JSONObject()); if (answered) sendSignal("call-accept", new JSONObject()); }
                    break;
                case "call-ringing": if (outgoing) notifyState("ringing"); break;
                case "call-accept":
                    if (!outgoing) break;
                    answered = true;
                    if (audioTrack != null) audioTrack.setEnabled(true);
                    notifyState("connecting");
                    if (peer != null) createOffer();
                    break;
                case "offer":
                    if (outgoing || !answered) break;
                    offerReceived = true;
                    processOffer(payload);
                    break;
                case "answer": if (outgoing) processAnswer(payload); break;
                case "ice-candidate": addRemoteCandidate(payload.optJSONObject("candidate")); break;
                case "call-hangup": case "call-decline": case "call-busy": reset(type); break;
                default: break;
            }
        } catch (Exception error) { Log.w(TAG, "signal parse failed", error); }
    }

    private void fetchTurn(int run) {
        try {
            JSONObject body = new JSONObject().put("code", room.code).put("token", room.token);
            Request request = new Request.Builder().url("https://vaultlix.com/api/turn-credentials")
                    .post(RequestBody.create(body.toString(), MediaType.get("application/json"))).build();
            http.newCall(request).enqueue(new Callback() {
                @Override public void onFailure(Call call, java.io.IOException e) { }
                @Override public void onResponse(Call call, Response response) {
                    try (Response closeable = response) {
                        String value = closeable.body() == null ? "" : closeable.body().string();
                        executor.execute(() -> { if (run == generation) createPeer(value); });
                    } catch (Exception ignored) {}
                }
            });
        } catch (Exception ignored) {}
    }

    private void createPeer(String turnJson) {
        if (peer != null || room == null) return;
        try {
            JSONArray servers = new JSONObject(turnJson).getJSONArray("iceServers");
            List<PeerConnection.IceServer> ice = new ArrayList<>();
            for (int i = 0; i < servers.length(); i++) {
                JSONObject item = servers.getJSONObject(i);
                List<String> urls = new ArrayList<>();
                Object raw = item.get("urls");
                if (raw instanceof JSONArray) for (int j = 0; j < ((JSONArray) raw).length(); j++) urls.add(((JSONArray) raw).getString(j));
                else urls.add(String.valueOf(raw));
                ice.add(PeerConnection.IceServer.builder(urls)
                        .setUsername(item.optString("username")).setPassword(item.optString("credential")).createIceServer());
            }
            PeerConnection.RTCConfiguration config = new PeerConnection.RTCConfiguration(ice);
            config.iceTransportsType = PeerConnection.IceTransportsType.RELAY;
            config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
            peer = factory.createPeerConnection(config, new PeerObserver());
            if (peer == null) { reset("peer-failed"); return; }
            audioSource = factory.createAudioSource(new MediaConstraints());
            audioTrack = factory.createAudioTrack("vaultlix-native-audio", audioSource);
            audioTrack.setEnabled(answered);
            peer.addTrack(audioTrack, Collections.singletonList("vaultlix-native-stream"));
            if (outgoing && answered) createOffer();
        } catch (Exception error) { Log.w(TAG, "TURN/peer setup failed", error); }
    }

    private void createOffer() {
        if (peer == null) return;
        peer.createOffer(new SimpleSdpObserver() {
            @Override public void onCreateSuccess(SessionDescription sdp) {
                peer.setLocalDescription(new SimpleSdpObserver() {
                    @Override public void onSetSuccess() { sendSdp("offer", sdp); }
                }, sdp);
            }
        }, new MediaConstraints());
    }

    private void processOffer(JSONObject payload) {
        if (peer == null) return;
        SessionDescription offer = new SessionDescription(SessionDescription.Type.OFFER, payload.optString("sdp"));
        peer.setRemoteDescription(new SimpleSdpObserver() {
            @Override public void onSetSuccess() {
                flushIce();
                peer.createAnswer(new SimpleSdpObserver() {
                    @Override public void onCreateSuccess(SessionDescription answer) {
                        peer.setLocalDescription(new SimpleSdpObserver() {
                            @Override public void onSetSuccess() { sendSdp("answer", answer); }
                        }, answer);
                    }
                }, new MediaConstraints());
            }
        }, offer);
    }

    private void processAnswer(JSONObject payload) {
        if (peer == null) return;
        peer.setRemoteDescription(new SimpleSdpObserver() { @Override public void onSetSuccess() { flushIce(); } },
                new SessionDescription(SessionDescription.Type.ANSWER, payload.optString("sdp")));
    }

    private void sendSdp(String type, SessionDescription sdp) {
        try { sendSignal(type, new JSONObject().put("type", type).put("sdp", sdp.description)); } catch (Exception ignored) {}
    }

    private void addRemoteCandidate(JSONObject value) {
        if (value == null) return;
        IceCandidate candidate = new IceCandidate(value.optString("sdpMid", null), value.optInt("sdpMLineIndex", 0), value.optString("candidate"));
        if (peer == null || peer.getRemoteDescription() == null) pendingIce.add(candidate); else peer.addIceCandidate(candidate);
    }

    private void flushIce() { if (peer != null) { for (IceCandidate item : pendingIce) peer.addIceCandidate(item); pendingIce.clear(); } }

    private void sendInvite() { try { sendSignal("call-invite", new JSONObject().put("from", callerName)); } catch (Exception ignored) {} }

    private void sendSignal(String type, JSONObject payload) {
        try {
            JSONObject wire = new JSONObject().put("type", type).put("sessionId", sessionId).put("envelope", encrypt(payload));
            if (!signalingReady || socket == null) { if (queuedSignals.size() < 128) queuedSignals.add(wire); return; }
            socket.send(wire.toString());
        } catch (Exception error) { Log.w(TAG, "signal encryption failed", error); }
    }

    private void flushSignals() { while (!queuedSignals.isEmpty() && socket != null) socket.send(queuedSignals.remove().toString()); }

    private String encrypt(JSONObject payload) throws Exception {
        JSONObject wrapped = new JSONObject().put("seq", ++sequenceOut).put("ts", System.currentTimeMillis()).put("payload", payload);
        byte[] iv = new byte[12]; random.nextBytes(iv);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(room.aesKey, "AES"), new GCMParameterSpec(128, iv));
        byte[] encrypted = cipher.doFinal(wrapped.toString().getBytes(StandardCharsets.UTF_8));
        ByteBuffer combined = ByteBuffer.allocate(iv.length + encrypted.length).put(iv).put(encrypted);
        return "v:" + Base64.encodeToString(combined.array(), Base64.NO_WRAP);
    }

    private JSONObject decrypt(String envelope) {
        try {
            if (!envelope.startsWith("v:")) return null;
            byte[] combined = Base64.decode(envelope.substring(2), Base64.DEFAULT);
            byte[] iv = new byte[12]; byte[] encrypted = new byte[combined.length - 12];
            System.arraycopy(combined, 0, iv, 0, 12); System.arraycopy(combined, 12, encrypted, 0, encrypted.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(room.aesKey, "AES"), new GCMParameterSpec(128, iv));
            JSONObject wrapped = new JSONObject(new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8));
            int sequence = wrapped.getInt("seq");
            if (sequence <= sequenceIn) return null;
            sequenceIn = sequence;
            return wrapped.getJSONObject("payload");
        } catch (Exception ignored) { return null; }
    }

    private void scheduleInviteRetry(int run, int remaining) {
        if (remaining <= 0) return;
        scheduler.schedule(() -> executor.execute(() -> {
            if (run == generation && outgoing && !answered) { sendInvite(); scheduleInviteRetry(run, remaining - 1); }
        }), 3, TimeUnit.SECONDS);
    }

    private void scheduleAcceptRetry(int run, int remaining) {
        if (remaining <= 0) return;
        scheduler.schedule(() -> executor.execute(() -> {
            if (run == generation && answered && !offerReceived && !outgoing) {
                sendSignal("call-accept", new JSONObject()); scheduleAcceptRetry(run, remaining - 1);
            }
        }), 1500, TimeUnit.MILLISECONDS);
    }

    private void notifyState(String state) { for (Listener listener : listeners) listener.onState(state); }

    private void reset(String reason) {
        generation++;
        WebSocket oldSocket = socket; socket = null; if (oldSocket != null) oldSocket.cancel();
        if (peer != null) { peer.close(); peer.dispose(); peer = null; }
        if (audioTrack != null) { audioTrack.setEnabled(false); audioTrack.dispose(); audioTrack = null; }
        if (audioSource != null) { audioSource.dispose(); audioSource = null; }
        room = null; signalingReady = false; outgoing = false; answered = false; offerReceived = false;
        sequenceOut = 0; sequenceIn = 0; peerSessionId = null; queuedSignals.clear(); pendingIce.clear();
        if (reason != null) for (Listener listener : listeners) listener.onEnded(reason);
        currentRoomCode = "";
    }

    private final class PeerObserver implements PeerConnection.Observer {
        @Override public void onIceCandidate(IceCandidate candidate) {
            executor.execute(() -> { try { sendSignal("ice-candidate", new JSONObject().put("candidate", new JSONObject()
                    .put("sdpMid", candidate.sdpMid).put("sdpMLineIndex", candidate.sdpMLineIndex).put("candidate", candidate.sdp))); } catch (Exception ignored) {} });
        }
        @Override public void onIceConnectionChange(PeerConnection.IceConnectionState state) {
            if (state == PeerConnection.IceConnectionState.CONNECTED || state == PeerConnection.IceConnectionState.COMPLETED) {
                executor.execute(() -> { notifyState("connected"); for (Listener listener : listeners) listener.onConnected(); });
            } else if (state == PeerConnection.IceConnectionState.FAILED) executor.execute(() -> reset("connection-failed"));
        }
        @Override public void onSignalingChange(PeerConnection.SignalingState state) {}
        @Override public void onIceConnectionReceivingChange(boolean receiving) {}
        @Override public void onIceGatheringChange(PeerConnection.IceGatheringState state) {}
        @Override public void onIceCandidatesRemoved(IceCandidate[] candidates) {}
        @Override public void onAddStream(MediaStream stream) {}
        @Override public void onRemoveStream(MediaStream stream) {}
        @Override public void onDataChannel(DataChannel channel) {}
        @Override public void onRenegotiationNeeded() {}
        @Override public void onAddTrack(RtpReceiver receiver, MediaStream[] streams) {}
    }

    private static class SimpleSdpObserver implements SdpObserver {
        @Override public void onCreateSuccess(SessionDescription sdp) {}
        @Override public void onSetSuccess() {}
        @Override public void onCreateFailure(String error) { Log.w(TAG, error); }
        @Override public void onSetFailure(String error) { Log.w(TAG, error); }
    }
}
