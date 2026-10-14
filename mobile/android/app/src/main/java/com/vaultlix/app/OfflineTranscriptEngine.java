package com.vaultlix.app;

import android.content.Context;

import com.k2fsa.sherpa.onnx.FeatureConfig;
import com.k2fsa.sherpa.onnx.OfflineModelConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizer;
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizerResult;
import com.k2fsa.sherpa.onnx.OfflineStream;
import com.k2fsa.sherpa.onnx.OfflineWhisperModelConfig;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

final class OfflineTranscriptEngine {
    interface StatusListener { void onStatus(String state, int progress, String error); }
    interface TranscriptListener { void onComplete(String text, String error); }

    private static final String MODEL_VERSION = "whisper-base-int8-v1";
    private static final String PREVIOUS_MODEL_VERSION = "whisper-tiny-int8-v1";
    private static final String BASE_URL = "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base/resolve/main/";
    private static final ModelFile[] MODEL_FILES = new ModelFile[] {
            new ModelFile("base-encoder.int8.onnx", 29_120_534L, "0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11"),
            new ModelFile("base-decoder.int8.onnx", 130_672_026L, "9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d"),
            new ModelFile("base-tokens.txt", 816_730L, "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126")
    };

    private final Context context;
    private final File modelDir;
    private final ExecutorService executor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "vaultlix-offline-transcript");
        thread.setDaemon(true);
        return thread;
    });
    private final OkHttpClient http = new OkHttpClient.Builder().build();
    private final AtomicBoolean downloading = new AtomicBoolean(false);

    OfflineTranscriptEngine(Context context) {
        this.context = context.getApplicationContext();
        this.modelDir = new File(context.getFilesDir(), "offline-transcript/" + MODEL_VERSION);
    }

    boolean isReady() {
        for (ModelFile model : MODEL_FILES) {
            File file = new File(modelDir, model.name);
            if (!file.isFile() || file.length() != model.bytes) return false;
        }
        return true;
    }

    String state() { return isReady() ? "ready" : downloading.get() ? "downloading" : "not_downloaded"; }

    void download(StatusListener listener) {
        if (isReady()) { listener.onStatus("ready", 100, ""); return; }
        if (!downloading.compareAndSet(false, true)) { listener.onStatus("downloading", 0, ""); return; }
        executor.execute(() -> {
            try {
                if (!modelDir.exists() && !modelDir.mkdirs()) throw new IOException("Could not create model folder");
                long total = 0;
                for (ModelFile model : MODEL_FILES) total += model.bytes;
                long completed = 0;
                for (ModelFile model : MODEL_FILES) {
                    File destination = new File(modelDir, model.name);
                    if (destination.isFile() && destination.length() == model.bytes
                            && model.sha256.equals(sha256(destination))) {
                        completed += model.bytes;
                        continue;
                    }
                    File partial = new File(modelDir, model.name + ".download");
                    if (partial.exists()) partial.delete();
                    Request request = new Request.Builder().url(BASE_URL + model.name).build();
                    try (Response response = http.newCall(request).execute()) {
                        ResponseBody body = response.body();
                        if (!response.isSuccessful() || body == null) throw new IOException("Download failed");
                        try (InputStream input = body.byteStream(); FileOutputStream output = new FileOutputStream(partial)) {
                            byte[] buffer = new byte[64 * 1024];
                            long current = 0;
                            int count;
                            while ((count = input.read(buffer)) != -1) {
                                output.write(buffer, 0, count);
                                current += count;
                                int progress = (int) Math.min(99, ((completed + current) * 100L) / total);
                                listener.onStatus("downloading", progress, "");
                            }
                        }
                    }
                    if (partial.length() != model.bytes || !model.sha256.equals(sha256(partial))) {
                        partial.delete();
                        throw new IOException("Model verification failed");
                    }
                    if (destination.exists()) destination.delete();
                    if (!partial.renameTo(destination)) throw new IOException("Could not install model");
                    completed += model.bytes;
                }
                deleteRecursively(new File(context.getFilesDir(), "offline-transcript/" + PREVIOUS_MODEL_VERSION));
                listener.onStatus("ready", 100, "");
            } catch (Exception error) {
                listener.onStatus("error", 0, "Model download failed. Check your connection and try again.");
            } finally {
                downloading.set(false);
            }
        });
    }

    void transcribe(File pcmFile, String localeTag, TranscriptListener listener) {
        executor.execute(() -> {
            if (!isReady()) { listener.onComplete("", "Offline multilingual model is not downloaded."); return; }
            OfflineRecognizer recognizer = null;
            OfflineStream stream = null;
            try {
                OfflineWhisperModelConfig whisper = new OfflineWhisperModelConfig();
                whisper.setEncoder(new File(modelDir, "base-encoder.int8.onnx").getAbsolutePath());
                whisper.setDecoder(new File(modelDir, "base-decoder.int8.onnx").getAbsolutePath());
                whisper.setLanguage(languageCode(localeTag));
                whisper.setTask("transcribe");

                OfflineModelConfig model = new OfflineModelConfig();
                model.setWhisper(whisper);
                model.setTokens(new File(modelDir, "base-tokens.txt").getAbsolutePath());
                model.setNumThreads(Math.max(2, Math.min(4, Runtime.getRuntime().availableProcessors() - 1)));
                model.setProvider("cpu");

                FeatureConfig features = new FeatureConfig();
                features.setSampleRate(16_000);
                features.setFeatureDim(80);

                OfflineRecognizerConfig config = new OfflineRecognizerConfig();
                config.setFeatConfig(features);
                config.setModelConfig(model);
                // These models are downloaded into app-private storage and every
                // configured path is absolute. Passing an AssetManager makes
                // sherpa-onnx interpret them as packaged assets; its native layer
                // then terminates the process when it cannot resolve the token
                // file. A null AssetManager explicitly selects filesystem mode.
                recognizer = new OfflineRecognizer(null, config);
                stream = recognizer.createStream();
                stream.acceptWaveform(readPcm16(pcmFile), 16_000);
                recognizer.decode(stream);
                OfflineRecognizerResult result = recognizer.getResult(stream);
                String text = result == null ? "" : result.getText().trim();
                listener.onComplete(text, text.isEmpty() ? "No speech could be recognized." : "");
            } catch (Throwable error) {
                listener.onComplete("", "Offline transcription could not be completed.");
            } finally {
                if (stream != null) stream.release();
                if (recognizer != null) recognizer.release();
            }
        });
    }

    private static String languageCode(String localeTag) {
        String value = localeTag == null ? "" : localeTag.trim();
        if (value.isEmpty()) return "";
        String language = Locale.forLanguageTag(value).getLanguage();
        return language == null ? "" : language;
    }

    private static float[] readPcm16(File file) throws IOException {
        if (file.length() > Integer.MAX_VALUE || file.length() % 2 != 0) throw new IOException("Invalid PCM");
        byte[] bytes = new byte[(int) file.length()];
        try (FileInputStream input = new FileInputStream(file)) {
            int offset = 0;
            while (offset < bytes.length) {
                int count = input.read(bytes, offset, bytes.length - offset);
                if (count < 0) throw new IOException("Truncated PCM");
                offset += count;
            }
        }
        float[] samples = new float[bytes.length / 2];
        for (int i = 0; i < samples.length; i++) {
            int low = bytes[i * 2] & 0xff;
            int high = bytes[i * 2 + 1];
            short value = (short) ((high << 8) | low);
            samples[i] = value / 32768.0f;
        }
        return samples;
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        StringBuilder result = new StringBuilder();
        for (byte value : digest.digest()) result.append(String.format(Locale.ROOT, "%02x", value));
        return result.toString();
    }

    private static void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteRecursively(child);
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    private static final class ModelFile {
        final String name;
        final long bytes;
        final String sha256;
        ModelFile(String name, long bytes, String sha256) {
            this.name = name; this.bytes = bytes; this.sha256 = sha256;
        }
    }
}
