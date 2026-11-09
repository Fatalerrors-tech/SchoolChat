
let isRegistering = false;
let socket = null;
let currentUser = null;
let gifResults = [];

const $ = (id) => document.getElementById(id);

const authScreen = $("authScreen");
const chatScreen = $("chatScreen");
const authForm = $("authForm");
const twoFactorForm = $("twoFactorForm");

const usernameInput = $("username");
const passwordInput = $("password");

const authError = $("authError");
const twoFactorError = $("twoFactorError");

const messagesContainer = $("messages");
const messageInput = $("messageInput");
const messageForm = $("messageForm");

function show(element, visible) {
  if (!element) return;
  element.hidden = !visible;
  element.classList.toggle("hidden", !visible);
}

function showError(element, message) {
  if (!element) return;
  element.textContent = message || "";
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...options.headers
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Something went wrong.");
  }

  return data;
}

function showAuth() {
  show(authScreen, true);
  show(chatScreen, false);
  show(authForm, true);
  show(twoFactorForm, false);
}

function showChat(user) {
  currentUser = user;

  show(authScreen, false);
  show(chatScreen, true);

  $("myUsername").textContent = user.username;
  $("myAvatar").src = user.avatarUrl || "/default-avatar.svg";

  connectSocket();
  loadMessages();
}

function switchAuthMode() {
  isRegistering = !isRegistering;

  $("authTitle").textContent = isRegistering
    ? "Create an account"
    : "Welcome to WorldChat";

  $("authSubtitle").textContent = isRegistering
    ? "Choose a username and password to join."
    : "Log in to talk with people around the world.";

  $("authSubmit").textContent = isRegistering
    ? "Create account"
    : "Log in";

  $("switchText").textContent = isRegistering
    ? "Already have an account?"
    : "Don't have an account?";

  $("switchMode").textContent = isRegistering
    ? "Log in"
    : "Register";

  showError(authError, "");
}

// Switch between login and registration
$("switchMode").addEventListener("click", switchAuthMode);

// Register or log in
authForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  showError(authError, "");

  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  if (!username || !password) {
    showError(authError, "Enter your username and password.");
    return;
  }

  const button = $("authSubmit");
  button.disabled = true;

  try {
    const endpoint = isRegistering
      ? "/api/register"
      : "/api/login";

    const data = await api(endpoint, {
      method: "POST",
      body: JSON.stringify({ username, password })
    });

    if (data.needsTwoFactor) {
      show(authForm, false);
      show(twoFactorForm, true);
      $("twoFactorCode").focus();
      return;
    }

    if (data.user) {
      showChat(data.user);
    }
  } catch (error) {
    showError(authError, error.message);
  } finally {
    button.disabled = false;
  }
});

// Developer two-step verification
twoFactorForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  showError(twoFactorError, "");

  const code = $("twoFactorCode").value.trim();

  if (!code) {
    showError(twoFactorError, "Enter your verification code.");
    return;
  }

  const button = twoFactorForm.querySelector("button");
  if (button) button.disabled = true;

  try {
    const data = await api("/api/verify-2fa", {
      method: "POST",
      body: JSON.stringify({ code })
    });

    if (data.user) {
      showChat(data.user);
    }
  } catch (error) {
    showError(twoFactorError, error.message);
  } finally {
    if (button) button.disabled = false;
  }
});

// Connect to the live chat server
function connectSocket() {
  if (socket) {
    socket.disconnect();
  }

  socket = io();

  socket.on("connect", () => {
    $("connectionStatus").textContent = "Connected";
    $("connectionStatus").style.color = "#4ade80";
  });

  socket.on("disconnect", () => {
    $("connectionStatus").textContent = "Disconnected";
    $("connectionStatus").style.color = "#f87171";
  });

  socket.on("connect_error", () => {
    $("connectionStatus").textContent = "Connection error";
    $("connectionStatus").style.color = "#f87171";
  });

  socket.on("chat:message", (message) => {
    addMessage(message);
  });
}

// Load previous messages
async function loadMessages() {
  try {
    const messages = await api("/api/messages");

    messagesContainer.replaceChildren();

    messages.forEach(addMessage);

    scrollToBottom();
  } catch (error) {
    console.error("Could not load messages:", error);
  }
}

// Safely display a message
function addMessage(message) {
  if (!message || !message.id) return;

  // Avoid duplicate messages
  if (document.querySelector(`[data-message-id="${message.id}"]`)) {
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "message";
  wrapper.dataset.messageId = message.id;

  if (currentUser && message.user_id === currentUser.id) {
    wrapper.classList.add("own");
  }

  const header = document.createElement("div");
  header.className = "message-header";

  const username = document.createElement("strong");
  username.textContent = message.username || "Unknown user";

  const time = document.createElement("small");

  if (message.created_at) {
    const date = new Date(
      message.created_at.replace(" ", "T") + "Z"
    );

    time.textContent = Number.isNaN(date.getTime())
      ? ""
      : date.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit"
        });
  }

  header.append(username, time);
  wrapper.appendChild(header);

  if (message.body) {
    const body = document.createElement("div");
    body.className = "message-body";
    body.textContent = message.body;
    wrapper.appendChild(body);
  }

  if (message.gif_url) {
    const image = document.createElement("img");
    image.className = "message-gif";
    image.src = message.gif_url;
    image.alt = "GIF";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    wrapper.appendChild(image);
  }

  messagesContainer.appendChild(wrapper);
  scrollToBottom();
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Send a text message
messageForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const body = messageInput.value.trim();

  if (!body || !socket || !socket.connected) {
    return;
  }

  socket.emit("chat:send", { body });

  messageInput.value = "";
  messageInput.focus();
});

// Send with Enter, use Shift+Enter for a new line
messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    messageForm.requestSubmit();
  }
});

// Profile picture upload
$("avatarInput").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append("avatar", file);

  try {
    const data = await api("/api/avatar", {
      method: "POST",
      body: formData
    });

    if (data.avatarUrl) {
      $("myAvatar").src = data.avatarUrl;
      currentUser.avatarUrl = data.avatarUrl;
    }
  } catch (error) {
    alert(error.message);
  }

  event.target.value = "";
});

// Open and close the GIF picker
$("gifButton").addEventListener("click", () => {
  const picker = $("gifPicker");
  show(picker, picker.hidden || picker.classList.contains("hidden"));

  if (!picker.hidden) {
    $("gifSearch").focus();
  }
});

// Search Tenor GIFs
let gifSearchTimeout;

$("gifSearch").addEventListener("input", () => {
  clearTimeout(gifSearchTimeout);

  gifSearchTimeout = setTimeout(searchGifs, 400);
});

async function searchGifs() {
  const query = $("gifSearch").value.trim();

  if (!query) {
    $("gifResults").replaceChildren();
    return;
  }

  try {
    const data = await api(
      "/api/tenor?q=" + encodeURIComponent(query)
    );

    gifResults = data.results || [];
    displayGifs();
  } catch (error) {
    console.error("GIF search failed:", error);
  }
}

// Display GIF search results
function displayGifs() {
  const container = $("gifResults");
  container.replaceChildren();

  gifResults.forEach((gif) => {
    const button = document.createElement("button");
    button.className = "gif-result";
    button.type = "button";

    const image = document.createElement("img");
    image.src = gif.url;
    image.alt = gif.title || "GIF";
    image.loading = "lazy";

    button.appendChild(image);

    button.addEventListener("click", () => {
      sendGif(gif.url);
    });

    container.appendChild(button);
  });
}

// Send a selected GIF
function sendGif(url) {
  if (!socket || !socket.connected || !url) return;

  socket.emit("chat:send", { gifUrl: url });

  show($("gifPicker"), false);
  $("gifSearch").value = "";
  $("gifResults").replaceChildren();
}

// Log out
$("logoutButton").addEventListener("click", async () => {
  try {
    await api("/api/logout", {
      method: "POST"
    });
  } catch (error) {
    console.error("Logout failed:", error);
  }

  if (socket) {
    socket.disconnect();
    socket = null;
  }

  currentUser = null;
  messagesContainer.replaceChildren();

  showAuth();
});

// Restore an existing login when the page opens
async function initialize() {
  try {
    const data = await api("/api/me");

    if (data.user) {
      showChat(data.user);
    } else {
      showAuth();
    }
  } catch (error) {
    showAuth();
  }
}

initialize();
