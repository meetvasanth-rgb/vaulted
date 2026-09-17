package com.vaultlix.app;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

final class ImageSafetyPolicy {
    private ImageSafetyPolicy() {}
    // Model-specific preprocessing: full 224x224 RGB image -> BGR with VGG mean subtraction.
    static ByteBuffer input(int[] pixels) {
        if (pixels.length != 224 * 224) throw new IllegalArgumentException("Invalid image size");
        ByteBuffer buffer = ByteBuffer.allocateDirect(pixels.length * 3 * 4).order(ByteOrder.nativeOrder());
        for (int color : pixels) {
            buffer.putFloat((color & 255) - 103.939f);
            buffer.putFloat(((color >> 8) & 255) - 116.779f);
            buffer.putFloat(((color >> 16) & 255) - 123.68f);
        }
        buffer.rewind();
        return buffer;
    }
    // Android's decoder may show only the first APNG frame while WebView animates all frames.
    static boolean animatedOrInvalidPng(byte[] data) {
        byte[] signature = {(byte)137,80,78,71,13,10,26,10};
        if (data.length < 8) return false;
        for (int i=0;i<8;i++) if (data[i] != signature[i]) return false;
        int offset = 8;
        while (offset + 12 <= data.length) {
            long size = ((long)(data[offset]&255)<<24) | ((long)(data[offset+1]&255)<<16)
                    | ((long)(data[offset+2]&255)<<8) | (data[offset+3]&255);
            if (size > data.length - offset - 12) return true;
            if (data[offset+4]=='a' && data[offset+5]=='c' && data[offset+6]=='T' && data[offset+7]=='L') return true;
            if (data[offset+4]=='I' && data[offset+5]=='E' && data[offset+6]=='N' && data[offset+7]=='D') return false;
            offset += (int)size + 12;
        }
        return true;
    }
    static String verdict(float[] scores) {
        if (scores == null || scores.length != 2) return "unavailable";
        for (float score : scores) if (!Float.isFinite(score) || score < 0 || score > 1) return "unavailable";
        if (Math.abs(scores[0] + scores[1] - 1) > 0.02) return "unavailable";
        return scores[1] >= 0.70f ? "blocked" : "allowed";
    }
}
