package com.vaultlix.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class InstallInviteTest {
    @Test public void readsTheCodeFromAPlainReferrer() {
        assertEquals("ABC234", InstallInvite.parseCode("vaultlix_invite=ABC234"));
    }

    @Test public void ignoresOtherParametersAndKeepsLookingPastThem() {
        assertEquals("ABC234", InstallInvite.parseCode("utm_source=qr&vaultlix_invite=ABC234&utm_medium=card"));
    }

    @Test public void readsAStillEncodedReferrer() {
        assertEquals("XYZ789", InstallInvite.parseCode("vaultlix_invite%3DXYZ789"));
        assertEquals("XYZ789", InstallInvite.parseCode("utm_source%3Dqr%26vaultlix_invite%3DXYZ789"));
    }

    @Test public void normalisesCase() {
        assertEquals("ABC234", InstallInvite.parseCode("vaultlix_invite=abc234"));
    }

    @Test public void onlyAcceptsWellFormedCodes() {
        assertNull(InstallInvite.parseCode(null));
        assertNull(InstallInvite.parseCode(""));
        assertNull(InstallInvite.parseCode("utm_source=google-play&utm_medium=organic"));
        assertNull(InstallInvite.parseCode("vaultlix_invite="));
        assertNull(InstallInvite.parseCode("vaultlix_invite=ABC23"));      // too short
        assertNull(InstallInvite.parseCode("vaultlix_invite=ABC2345"));    // too long
        assertNull(InstallInvite.parseCode("vaultlix_invite=ABC0O1"));     // characters the codes never use
        assertNull(InstallInvite.parseCode("vaultlix_invite=ABC 234"));
        assertNull(InstallInvite.parseCode("vaultlix_invite=../../etc"));
        assertNull(InstallInvite.parseCode("othervaultlix_invite=ABC234"));
    }

    @Test public void refusesAnAbsurdlyLongReferrer() {
        StringBuilder long_ = new StringBuilder("vaultlix_invite=ABC234&x=");
        for (int i = 0; i < 3000; i++) long_.append('a');
        assertNull(InstallInvite.parseCode(long_.toString()));
    }

    @Test public void onlyARecentInstallIsAnInvitation() {
        long now = 2_000_000_000L;
        assertTrue(InstallInvite.isFresh(now - 60, now));
        assertTrue(InstallInvite.isFresh(now - InstallInvite.MAX_AGE_SECONDS, now));
        assertFalse(InstallInvite.isFresh(now - InstallInvite.MAX_AGE_SECONDS - 1, now));
        assertFalse(InstallInvite.isFresh(now + 7200, now));
        assertTrue(InstallInvite.isFresh(0, now));
    }
}
