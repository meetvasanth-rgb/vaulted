package com.vaultlix.app;

/**
 * Who has agreed to video on the current call and what is on. Pure state, no
 * Android or WebRTC types, so the consent rules can be tested on a plain JVM.
 *
 * Rules: no camera starts and no peer video is shown until both people have
 * agreed to switch this call to video; the agreement lasts for the call only.
 */
final class NativeVideoState {
    private boolean consent;
    private boolean cameraOn;
    private boolean remoteOn;

    boolean consent() { return consent; }
    boolean cameraOn() { return cameraOn; }
    boolean remoteOn() { return remoteOn; }

    /** Either the peer accepted our request, or we accepted theirs. */
    void grantConsent() { consent = true; }

    /** Whether this side may start its camera now. */
    boolean canStartCamera() { return consent; }

    /** Returns true if the camera state changed. */
    boolean setCamera(boolean on) {
        if (on && !consent) return false;
        if (cameraOn == on) return false;
        cameraOn = on;
        return true;
    }

    /** The peer reported its camera; without consent it is ignored. Returns true if the visible state changed. */
    boolean setRemote(boolean on) {
        boolean effective = consent && on;
        if (remoteOn == effective) return false;
        remoteOn = effective;
        return true;
    }

    /** End of call. Returns true if anything visible was on. */
    boolean reset() {
        boolean changed = cameraOn || remoteOn;
        consent = false;
        cameraOn = false;
        remoteOn = false;
        return changed;
    }
}
