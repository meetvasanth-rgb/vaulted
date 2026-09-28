// Keep the browser's dimmed transport overlay off the short homepage demo.
// Native controls remain available if this enhancement cannot load.
(() => {
  const video = document.getElementById('walkthrough-player');
  const button = document.querySelector('.walkthrough-toggle');
  const status = document.querySelector('.walkthrough-playback-status');
  if (!video || !button || !status) return;
  const sync = () => {
    button.textContent = video.ended ? 'Replay walkthrough' : video.paused ? 'Play walkthrough' : 'Pause walkthrough';
  };
  async function toggle() {
    status.textContent = '';
    if (!video.paused) { video.pause(); return; }
    if (video.ended) video.currentTime = 0;
    try { await video.play(); }
    catch (_) { status.textContent = 'Could not play the video. Please try again.'; }
    sync();
  }
  button.addEventListener('click', toggle);
  video.addEventListener('click', toggle);
  for (const event of ['play', 'pause', 'ended']) video.addEventListener(event, sync);
  video.addEventListener('error', () => {
    status.textContent = 'Could not load the video. Please refresh and try again.';
  });
  video.controls = false;
  button.hidden = false;
  sync();
})();
