const socket = io();

const video = document.getElementById("video");
const chat = document.getElementById("chat");
const form = document.getElementById("form");
const input = document.getElementById("input");
const roomLink = document.getElementById("roomLink");

const params = new URLSearchParams(window.location.search);
let room = params.get("room");

if (!room) {
  room = Math.random().toString(36).substring(2, 8);
  params.set("room", room);
  window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
}

roomLink.textContent = `Room ${room} - ${window.location.href}`;
socket.emit("join room", room);
