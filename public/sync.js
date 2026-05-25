let isHost = false;

socket.on("role", (data) => {
  isHost = Boolean(data.isHost);
  video.controls = isHost;
  console.log(isHost ? "HOST" : "VIEWER");
});

socket.on("change video", (url) => {
  video.src = url;
  video.load();
});

socket.on("sync state", ({ time = 0, playing = false, video: videoUrl = null }) => {
  if (videoUrl && video.src !== `${window.location.origin}${videoUrl}`) {
    video.src = videoUrl;
    video.load();
  }

  if (Math.abs(video.currentTime - time) > 0.5) {
    video.currentTime = time;
  }

  if (playing && video.paused) {
    video.play().catch(() => {});
  }

  if (!playing && !video.paused) {
    video.pause();
  }
});

video.onplay = () => {
  if (!isHost) {
    video.pause();
    return;
  }

  sendState();
};

video.onpause = () => {
  if (isHost) sendState();
};

video.onseeked = () => {
  if (isHost) sendState();
};

function sendState() {
  if (!isHost || !video.src) return;

  socket.emit("update state", {
    room,
    time: video.currentTime,
    playing: !video.paused
  });
}

setInterval(sendState, 1000);
