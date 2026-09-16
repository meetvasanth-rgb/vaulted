# Bundled image classifier

Source: https://github.com/lovoo/NSFWDetector
Pinned commit: 8ecbc9674686f4359f1b562dd27fc737ab794221
Model: NSFWDetector/Classes/NSFW.mlmodel
SHA-256: 1b872d9620b8d41f10132f29063d751ffb53c6785bae7f601a1d40f4bd873778
License: BSD 3-Clause, copyright LOVOO GmbH; reproduced in NSFW-LICENSE.txt and bundled in the app.

The model distinguishes NSFW/nudity from appropriate images. It does not classify all objectionable content. Initial blocking threshold is 0.70, selected as a conservative starting policy, not a calibrated guarantee. LocalImageSafety applies orientation, scales the full image to fit, runs Vision/Core ML on a serial background queue, and withholds images when inference fails. All frames of supported animations are checked (maximum 120 frames); oversized or unsupported images are withheld. No model downloads, image uploads, inference logs or persisted scores are used.

Validation before broader release should include real iPhones, varied lighting/skin tones/art/medical/ordinary photos, false positives/negatives, and cold/warm performance. Simulator and Mac smoke tests do not establish real-device accuracy. Updating the model or threshold requires re-evaluation and a new signed build.
