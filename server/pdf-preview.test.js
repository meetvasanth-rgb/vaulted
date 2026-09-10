'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const android = fs.readFileSync(path.join(root, 'mobile/android/app/src/main/java/com/vaultlix/app/MainActivity.java'), 'utf8');
const ios = fs.readFileSync(path.join(root, 'mobile/ios/App/App/SceneDelegate.swift'), 'utf8');

test('PDF previews render only on-device and travel inside the encrypted file payload', () => {
  assert.match(client, /import\('\/vendor\/pdf\.min\.mjs'\)/);
  assert.match(client, /getDocument\(\{ data:bytes, isEvalSupported:false \}\)/);
  assert.match(client, /pdfPreview, pageCount:Number\(pageCount\)/);
  assert.match(client, /safeImageDataUri\('image\/jpeg', parsed\.pdfPreview\)/);
  assert.doesNotMatch(client, /cdnjs|unpkg|jsdelivr/);
});

test('the pinned PDF renderer and worker are served from Vaultlix itself', () => {
  assert.match(server, /url === '\/vendor\/pdf\.min\.mjs'/);
  assert.match(server, /pdfjs-dist\/build\/pdf\.worker\.min\.mjs/);
  assert.match(server, /'\.mjs':'text\/javascript'/);
});

test('tapping a PDF opens the in-app viewer before sharing', () => {
  assert.match(client, /id="pdf-preview-overlay"/);
  assert.match(client, /if \(isPdfAttachment\(rec\.mime, rec\.fileName\)\) \{ openPdfPreview\(rec\); return; \}/);
  assert.match(client, /function changePdfPreviewPage\(direction\)/);
  assert.match(client, /function shareOpenPdf\(\)/);
});

test('PDF preview offers compact share and real platform download actions', () => {
  assert.match(client, /onclick="downloadOpenPdf\(\)" aria-label="Download PDF"/);
  assert.match(client, /onclick="shareOpenPdf\(\)" aria-label="Share PDF"/);
  assert.doesNotMatch(client, />Share PDF<\/button>/);
  assert.match(android, /public boolean saveMedia\(String dataUrl, String requestedName\)/);
  assert.match(android, /Intent\.ACTION_CREATE_DOCUMENT/);
  assert.match(ios, /if action == "saveMedia"/);
  assert.match(ios, /UIDocumentPickerViewController\(forExporting:/);
  assert.match(client, /onclick="openPdfInAnotherApp\(\)" aria-label="Open PDF with another app"/);
  assert.doesNotMatch(client, /Update Vaultlix to (?:download this PDF|choose a PDF app)/);
  assert.match(android, /Intent\.ACTION_VIEW/);
  assert.match(ios, /UIDocumentInteractionController\(url: fileURL\)/);
});

test('document rotation is enabled only while the PDF preview is open', () => {
  assert.match(client, /setDocumentPreviewRotation\(true\)/);
  assert.match(client, /setDocumentPreviewRotation\(false\)/);
  assert.match(android, /SCREEN_ORIENTATION_SENSOR/);
  assert.match(android, /SCREEN_ORIENTATION_PORTRAIT/);
  assert.match(ios, /setDocumentPreviewOpen\(_ open: Bool\)/);
});

test('PDF preview supports document-only pinch zoom and panning', () => {
  assert.match(client, /function applyPdfPreviewZoom\(zoom\)/);
  assert.match(client, /pdfTouchDistance\(event\.touches\)/);
  assert.match(client, /Math\.max\(1, Math\.min\(4,/);
  assert.match(client, /pdfPreviewStage\.scrollLeft =/);
  assert.match(client, /pdfPreviewStage\.scrollTop =/);
  assert.match(client, /touchmove'[\s\S]*passive:false/);
});
