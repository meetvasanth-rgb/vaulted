import Foundation
import CryptoKit
import SherpaOnnx

final class OfflineTranscriptEngine {
    typealias StatusHandler = (_ state: String, _ progress: Int, _ error: String) -> Void
    typealias TranscriptHandler = (_ text: String, _ error: String) -> Void

    static let shared = OfflineTranscriptEngine()

    private struct ModelFile {
        let name: String
        let bytes: Int64
        let sha256: String
    }

    private let baseURL = URL(string: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny/resolve/main/")!
    private let files = [
        ModelFile(name: "tiny-encoder.int8.onnx", bytes: 12_937_772, sha256: "d24fb083ae3b1041fc24e97971d60e280c9342201fbb67b0ab428a8b4a51a434"),
        ModelFile(name: "tiny-decoder.int8.onnx", bytes: 89_855_401, sha256: "d2fece8dd42771f1df975c6c0445770d0c292bf7547c2cae04a6c0cc57540925"),
        ModelFile(name: "tiny-tokens.txt", bytes: 816_730, sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126"),
    ]
    private let queue = DispatchQueue(label: "com.vaultlix.offline-transcript", qos: .userInitiated)
    private var downloading = false

    private lazy var modelDirectory: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("OfflineTranscript/whisper-tiny-int8-v1", isDirectory: true)
    }()

    var isReady: Bool {
        let manager = FileManager.default
        return files.allSatisfy { model in
            let url = modelDirectory.appendingPathComponent(model.name)
            guard let values = try? url.resourceValues(forKeys: [.fileSizeKey]),
                  values.fileSize == Int(model.bytes) else { return false }
            return manager.fileExists(atPath: url.path)
        }
    }

    var state: String { isReady ? "ready" : downloading ? "downloading" : "not_downloaded" }

    func download(status: @escaping StatusHandler) {
        queue.async {
            if self.isReady { self.report(status, "ready", 100, ""); return }
            guard !self.downloading else { self.report(status, "downloading", 0, ""); return }
            self.downloading = true
            defer { self.downloading = false }
            do {
                try FileManager.default.createDirectory(at: self.modelDirectory, withIntermediateDirectories: true)
                for (index, model) in self.files.enumerated() {
                    let destination = self.modelDirectory.appendingPathComponent(model.name)
                    if try self.fileMatches(destination, model: model) {
                        self.report(status, "downloading", ((index + 1) * 100) / self.files.count, "")
                        continue
                    }
                    let semaphore = DispatchSemaphore(value: 0)
                    var result: Result<URL, Error>!
                    let task = URLSession.shared.downloadTask(with: self.baseURL.appendingPathComponent(model.name)) { temporary, response, error in
                        defer { semaphore.signal() }
                        if let error { result = .failure(error); return }
                        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), let temporary else {
                            result = .failure(NSError(domain: "VaultlixOfflineTranscript", code: 1)); return
                        }
                        let staged = self.modelDirectory.appendingPathComponent(model.name + ".download")
                        do {
                            try? FileManager.default.removeItem(at: staged)
                            try FileManager.default.moveItem(at: temporary, to: staged)
                            result = .success(staged)
                        } catch { result = .failure(error) }
                    }
                    task.resume()
                    semaphore.wait()
                    let staged = try result.get()
                    guard try self.fileMatches(staged, model: model) else {
                        try? FileManager.default.removeItem(at: staged)
                        throw NSError(domain: "VaultlixOfflineTranscript", code: 2)
                    }
                    try? FileManager.default.removeItem(at: destination)
                    try FileManager.default.moveItem(at: staged, to: destination)
                    try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: destination.path)
                    self.report(status, "downloading", ((index + 1) * 100) / self.files.count, "")
                }
                self.report(status, "ready", 100, "")
            } catch {
                self.report(status, "error", 0, "Model download failed. Check your connection and try again.")
            }
        }
    }

    func transcribe(pcm: Data, localeIdentifier: String, completion: @escaping TranscriptHandler) {
        queue.async {
            guard self.isReady else {
                DispatchQueue.main.async { completion("", "Offline multilingual model is not downloaded.") }
                return
            }
            let samples = self.floatSamples(fromPCM16: pcm)
            guard !samples.isEmpty else {
                DispatchQueue.main.async { completion("", "No speech could be recognized.") }
                return
            }
            let whisper = sherpaOnnxOfflineWhisperModelConfig(
                encoder: self.modelDirectory.appendingPathComponent("tiny-encoder.int8.onnx").path,
                decoder: self.modelDirectory.appendingPathComponent("tiny-decoder.int8.onnx").path,
                language: self.languageCode(localeIdentifier),
                task: "transcribe"
            )
            let model = sherpaOnnxOfflineModelConfig(
                tokens: self.modelDirectory.appendingPathComponent("tiny-tokens.txt").path,
                whisper: whisper,
                numThreads: max(2, min(4, ProcessInfo.processInfo.processorCount - 1))
            )
            let features = sherpaOnnxFeatureConfig(sampleRate: 16_000, featureDim: 80)
            var config = sherpaOnnxOfflineRecognizerConfig(featConfig: features, modelConfig: model)
            let recognizer = SherpaOnnxOfflineRecognizer(config: &config)
            let text = recognizer.decode(samples: samples, sampleRate: 16_000).text.trimmingCharacters(in: .whitespacesAndNewlines)
            DispatchQueue.main.async {
                completion(text, text.isEmpty ? "No speech could be recognized." : "")
            }
        }
    }

    private func languageCode(_ identifier: String) -> String {
        guard !identifier.isEmpty else { return "" }
        return Locale(identifier: identifier).languageCode ?? ""
    }

    private func floatSamples(fromPCM16 data: Data) -> [Float] {
        guard data.count >= 2, data.count.isMultiple(of: 2) else { return [] }
        let bytes = [UInt8](data)
        return stride(from: 0, to: bytes.count, by: 2).map { index in
            let bits = UInt16(bytes[index]) | (UInt16(bytes[index + 1]) << 8)
            return Float(Int16(bitPattern: bits)) / 32768.0
        }
    }

    private func fileMatches(_ url: URL, model: ModelFile) throws -> Bool {
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              size == Int(model.bytes) else { return false }
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() == model.sha256
    }

    private func report(_ handler: @escaping StatusHandler, _ state: String, _ progress: Int, _ error: String) {
        DispatchQueue.main.async { handler(state, progress, error) }
    }
}
