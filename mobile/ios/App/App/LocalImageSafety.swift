import Foundation
import CoreML
import Vision
import ImageIO

/// No networking, logging, or media persistence. Inference runs off the UI thread.
final class LocalImageSafety {
    static let shared = LocalImageSafety()
    private let queue = DispatchQueue(label: "com.vaultlix.image-safety", qos: .userInitiated)
    private var model: VNCoreMLModel?
    private let modelURL: URL?

    init(modelURL: URL? = Bundle.main.url(forResource: "NSFW", withExtension: "mlmodelc")) {
        self.modelURL = modelURL
    }
    private let slots = DispatchSemaphore(value: 3)

    func check(base64: String, completion: @escaping (String) -> Void) {
        guard base64.utf8.count <= 14 * 1024 * 1024,
              slots.wait(timeout: .now()) == .success else { completion("unavailable"); return }
        queue.async {
            defer { self.slots.signal() }
            let result: String = autoreleasepool {
                do { return try self.classify(base64: base64) }
                catch { return "unavailable" }
            }
            DispatchQueue.main.async { completion(result) }
        }
    }

    private func classify(base64: String) throws -> String {
        guard let data = Data(base64Encoded: base64), !data.isEmpty,
              let source = CGImageSourceCreateWithData(data as CFData, nil) else { return "unavailable" }
        let count = CGImageSourceGetCount(source)
        // Check every decoded animation frame, or refuse an oversized animation.
        guard count > 0, count <= 120 else { return "unavailable" }
        if model == nil {
            guard let url = modelURL else { return "unavailable" }
            let configuration = MLModelConfiguration()
            #if targetEnvironment(simulator)
            configuration.computeUnits = .cpuOnly
            #endif
            model = try VNCoreMLModel(for: MLModel(contentsOf: url, configuration: configuration))
        }
        guard let model else { return "unavailable" }
        let deadline = Date().addingTimeInterval(20)
        for index in 0..<count {
            guard Date() < deadline,
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? Int,
                  let height = properties[kCGImagePropertyPixelHeight] as? Int,
                  width > 0, height > 0, width <= 25000, height <= 25000,
                  width * height <= 40_000_000 else { return "unavailable" }
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 1024,
                kCGImageSourceShouldCacheImmediately: true
            ]
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, index, options as CFDictionary) else { return "unavailable" }
            let request = VNCoreMLRequest(model: model)
            request.imageCropAndScaleOption = .scaleFit
            try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
            guard let results = request.results as? [VNClassificationObservation],
                  let score = results.first(where: { $0.identifier == "NSFW" })?.confidence,
                  score.isFinite else { return "unavailable" }
            // Conservative initial policy; real-device evaluation is required before release.
            if score >= 0.70 { return "blocked" }
        }
        return "allowed"
    }
}
