async function uploadVideo() {
  if (!isHost) {
    alert("Seul l'hote peut changer la video");
    return;
  }

  const fileInput = document.getElementById("fileInput");
  const file = fileInput.files[0];

  if (!file) {
    alert("Choisis une video");
    return;
  }

  const formData = new FormData();
  formData.append("video", file);

  try {
    const res = await fetch("/upload", {
      method: "POST",
      body: formData
    });

    if (!res.ok) {
      throw new Error("Upload impossible");
    }

    const data = await res.json();
    socket.emit("change video", { room, url: data.url });
  } catch (err) {
    console.error("Erreur upload:", err);
    alert("Erreur lors de l'upload");
  } finally {
    fileInput.value = "";
  }
}
