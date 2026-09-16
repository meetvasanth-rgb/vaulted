# Offline Android image classifier

Model: assets/nsfw.tflite from https://github.com/hoyaaaa/nsfw_detector_flutter
Pinned revision: 77f6c72397113c7facb7ba4783ccfe70caec7c81
SHA-256: a476ef325f4f776602d944fd28133e945f77a74e37dafba37936110b35b7810d
Lineage: Yahoo Open NSFW via devzwy/open_nsfw_android. Model BSD-3-Clause notice and redistribution source MIT notice are included in LICENSE.txt.

The model is approximately 22 MB, separate from the Apple-specific iOS model. It accepts float32 [1,224,224,3], full-image resize, BGR channel order with means [103.939,116.779,123.68] subtracted. Output [1,2] is [safe,NSFW]. Initial block threshold: 0.70. This is not calibrated equivalence to the iOS model or a guarantee of accuracy.

Bundled with LiteRT 1.4.2; serial background CPU inference with two interpreter threads. No remote model fetch, network screening, media persistence or inference-result logging. All images are decoded with size limits and EXIF orientation handled by ImageDecoder. Animated GIF/WebP and APNG are withheld rather than allowing unchecked frames; static images are supported. Failure or invalid model output is not treated as safe.

Model inference was smoke-tested locally with an app icon and a synthetic solid-color image. Native preprocessing, threshold validation and APNG rejection have unit tests. Performance and false-positive/false-negative evaluation on real Android phones are still required.
