package com.vaultlix.app;

import android.content.Context;
import android.content.res.AssetManager;
import android.graphics.Bitmap;
import android.graphics.ImageDecoder;
import android.graphics.drawable.AnimatedImageDrawable;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.util.Base64;
import org.tensorflow.lite.DataType;
import org.tensorflow.lite.Interpreter;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.RejectedExecutionException;

/** Process-local classifier. No network calls, media files, logging or persisted scores. */
final class LocalImageSafety {
    interface Callback { void done(String status); }
    private static LocalImageSafety instance;
    private final AssetManager assets;
    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(2));
    private Interpreter interpreter;
    private ByteBuffer model;

    static synchronized LocalImageSafety get(Context context) {
        if (instance == null) instance = new LocalImageSafety(context.getApplicationContext());
        return instance;
    }
    private LocalImageSafety(Context context) { this.assets = context.getAssets(); worker.allowCoreThreadTimeOut(true); }

    void check(String base64, Callback callback) {
        if (base64 == null || base64.isEmpty() || base64.length() > 14 * 1024 * 1024) {
            callback.done("unavailable"); return;
        }
        try {
            worker.execute(() -> {
                String result;
                try { result = classify(Base64.decode(base64, Base64.NO_WRAP)); }
                catch (Exception | LinkageError e) { result = "unavailable"; }
                callback.done(result);
            });
        } catch (RejectedExecutionException e) { callback.done("unavailable"); }
    }

    private String classify(byte[] data) throws Exception {
        if (data.length == 0 || data.length > 10 * 1024 * 1024 || ImageSafetyPolicy.animatedOrInvalidPng(data)) return "unavailable";
        Drawable drawable = ImageDecoder.decodeDrawable(ImageDecoder.createSource(ByteBuffer.wrap(data)),
                (decoder, info, source) -> {
                    int width = info.getSize().getWidth(), height = info.getSize().getHeight();
                    if (width <= 0 || height <= 0 || (long) width * height > 40_000_000L)
                        throw new IllegalArgumentException("Image too large");
                    decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
                    decoder.setTargetSize(224, 224);
                    decoder.setOnPartialImageListener(error -> false);
                });
        // Never classify only the first frame and then allow an entire animation.
        if (drawable instanceof AnimatedImageDrawable) return "unavailable";
        if (!(drawable instanceof BitmapDrawable)) return "unavailable";
        Bitmap bitmap = ((BitmapDrawable) drawable).getBitmap();
        try {
            ensureModel();
            int[] pixels = new int[224 * 224];
            bitmap.getPixels(pixels, 0, 224, 0, 0, 224, 224);
            ByteBuffer input = ImageSafetyPolicy.input(pixels);
            float[][] output = new float[1][2];
            interpreter.run(input, output);
            return ImageSafetyPolicy.verdict(output[0]);
        } finally { bitmap.recycle(); }
    }

    private void ensureModel() throws Exception {
        if (interpreter != null) return;
        try (InputStream stream = assets.open("models/nsfw.tflite")) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int count;
            while ((count = stream.read(chunk)) != -1) out.write(chunk, 0, count);
            byte[] bytes = out.toByteArray();
            model = ByteBuffer.allocateDirect(bytes.length).order(ByteOrder.nativeOrder());
            model.put(bytes).rewind();
        }
        Interpreter candidate = new Interpreter(model, new Interpreter.Options().setNumThreads(2));
        if (!Arrays.equals(candidate.getInputTensor(0).shape(), new int[]{1,224,224,3})
                || !Arrays.equals(candidate.getOutputTensor(0).shape(), new int[]{1,2})
                || candidate.getInputTensor(0).dataType() != DataType.FLOAT32
                || candidate.getOutputTensor(0).dataType() != DataType.FLOAT32) {
            candidate.close(); throw new IllegalStateException("Unsupported image model");
        }
        interpreter = candidate;
    }
}
