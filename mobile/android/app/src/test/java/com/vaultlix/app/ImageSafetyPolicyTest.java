package com.vaultlix.app;
import org.junit.Test;
import static org.junit.Assert.*;
import java.nio.ByteBuffer;
import java.util.Arrays;

public class ImageSafetyPolicyTest {
    @Test public void inputUsesBgrMeanSubtractionAndRewinds() {
        int[] pixels = new int[224 * 224];
        Arrays.fill(pixels, 0xFFFF8040);
        ByteBuffer input = ImageSafetyPolicy.input(pixels);
        assertEquals(0, input.position());
        assertEquals(224 * 224 * 3 * 4, input.remaining());
        assertEquals(64 - 103.939f, input.getFloat(), 0.0001f);
        assertEquals(128 - 116.779f, input.getFloat(), 0.0001f);
        assertEquals(255 - 123.68f, input.getFloat(), 0.0001f);
    }
    @Test public void apngCannotBypassChecksThroughAnUnscreenedFrame() {
        byte[] apng = {(byte)137,80,78,71,13,10,26,10,0,0,0,0,97,99,84,76,0,0,0,0};
        assertTrue(ImageSafetyPolicy.animatedOrInvalidPng(apng));
        byte[] truncated = {(byte)137,80,78,71,13,10,26,10,127,0,0,0,73,68,65,84,0,0,0,0};
        assertTrue(ImageSafetyPolicy.animatedOrInvalidPng(truncated));
        assertFalse(ImageSafetyPolicy.animatedOrInvalidPng(new byte[]{(byte)255,(byte)216,(byte)255}));
    }
    @Test public void policyBlocksAtThresholdAndFailsClosedOnInvalidOutput() {
        assertEquals("allowed", ImageSafetyPolicy.verdict(new float[]{0.95f,0.05f}));
        assertEquals("blocked", ImageSafetyPolicy.verdict(new float[]{0.3f,0.7f}));
        assertEquals("blocked", ImageSafetyPolicy.verdict(new float[]{0.01f,0.99f}));
        assertEquals("unavailable", ImageSafetyPolicy.verdict(new float[]{0,0}));
        assertEquals("unavailable", ImageSafetyPolicy.verdict(new float[]{1,Float.NaN}));
        assertEquals("unavailable", ImageSafetyPolicy.verdict(new float[]{1,-0.01f}));
        assertEquals("unavailable", ImageSafetyPolicy.verdict(new float[]{0.1f}));
    }
}
