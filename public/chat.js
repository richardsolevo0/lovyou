form.addEventListener("submit", (event) => {
  event.preventDefault();

  const text = input.value.trim();
  if (!text) return;

  socket.emit("chat message", { room, msg: text });
  input.value = "";
});

socket.on("chat message", (msg) => {
  const item = document.createElement("div");
  item.textContent = typeof msg === "string" ? msg : msg.text;
  chat.appendChild(item);
  chat.scrollTop = chat.scrollHeight;
});
