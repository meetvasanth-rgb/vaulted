package com.vaultlix.app;

final class NativeCallRouting {
    private NativeCallRouting() {}

    static boolean isCompeting(String activeRoom, String preparingRoom, String incomingRoom) {
        String active = normalize(activeRoom);
        String preparing = normalize(preparingRoom);
        String incoming = normalize(incomingRoom);
        if (incoming.isEmpty()) return !active.isEmpty() || !preparing.isEmpty();
        return (!active.isEmpty() && !incoming.equals(active))
                || (!preparing.isEmpty() && !incoming.equals(preparing));
    }

    static boolean shouldHandleEnd(String activeRoom, String preparingRoom, String endedRoom) {
        String active = normalize(activeRoom);
        String preparing = normalize(preparingRoom);
        String ended = normalize(endedRoom);
        if (active.isEmpty() && preparing.isEmpty()) return true;
        if (ended.isEmpty()) return false;
        return ended.equals(active) || ended.equals(preparing);
    }

    private static String normalize(String value) {
        return value == null ? "" : value.trim();
    }
}
