package com.vaultlix.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NativeCallRoutingTest {
    @Test
    public void competingRoomIsBusy() {
        assertTrue(NativeCallRouting.isCompeting("room-a", "", "room-b"));
        assertTrue(NativeCallRouting.isCompeting("", "room-a", "room-b"));
        assertFalse(NativeCallRouting.isCompeting("room-a", "", "room-a"));
    }

    @Test
    public void remoteEndMustMatchActiveRoom() {
        assertFalse(NativeCallRouting.shouldHandleEnd("room-a", "", "room-b"));
        assertFalse(NativeCallRouting.shouldHandleEnd("room-a", "", ""));
        assertTrue(NativeCallRouting.shouldHandleEnd("room-a", "", "room-a"));
        assertTrue(NativeCallRouting.shouldHandleEnd("", "", "room-b"));
    }
}
