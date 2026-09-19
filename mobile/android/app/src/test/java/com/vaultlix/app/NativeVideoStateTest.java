package com.vaultlix.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NativeVideoStateTest {
    @Test public void noCameraBeforeBothAgree() {
        NativeVideoState state = new NativeVideoState();
        assertFalse(state.canStartCamera());
        assertFalse(state.setCamera(true));
        assertFalse(state.cameraOn());
    }

    @Test public void peerVideoIsIgnoredUntilConsent() {
        NativeVideoState state = new NativeVideoState();
        assertFalse(state.setRemote(true));
        assertFalse(state.remoteOn());
        state.grantConsent();
        assertTrue(state.setRemote(true));
        assertTrue(state.remoteOn());
    }

    @Test public void afterConsentEitherCameraTogglesFreely() {
        NativeVideoState state = new NativeVideoState();
        state.grantConsent();
        assertTrue(state.setCamera(true));
        assertFalse("no change reported when already on", state.setCamera(true));
        assertTrue(state.setCamera(false));
        assertTrue(state.setRemote(true));
        assertTrue(state.setRemote(false));
        assertFalse(state.remoteOn());
    }

    @Test public void consentEndsWithTheCall() {
        NativeVideoState state = new NativeVideoState();
        state.grantConsent();
        state.setCamera(true);
        state.setRemote(true);
        assertTrue(state.reset());
        assertFalse(state.consent());
        assertFalse(state.cameraOn());
        assertFalse(state.remoteOn());
        // a following call starts from scratch
        assertFalse(state.setCamera(true));
        assertFalse(state.setRemote(true));
        assertFalse("nothing was on, nothing to report", state.reset());
    }

    @Test public void turningTheCameraOffIsAlwaysAllowed() {
        NativeVideoState state = new NativeVideoState();
        state.grantConsent();
        state.setCamera(true);
        state.reset();
        assertFalse(state.setCamera(false));
    }
}
