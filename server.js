
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const nodemailer = require("nodemailer");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || "./data";
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "chat.sqlite"));

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  avatar_url TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  avatar_url TEXT,
  body TEXT,
  gif_url TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

const findUser = db.prepare(
  "SELECT * FROM users WHERE username = ?"
);

const findUserById = db.prepare(
  "SELECT id, username, avatar_url FROM users WHERE id = ?"
);

const createUser = db.prepare(
  "INSERT INTO users (username, password_hash) VALUES (?, ?)"
);

const sessionMiddleware = session({
  store: new (require("connect-sqlite3")(session))({
    db: "sessions.sqlite",
    dir: DATA_DIR
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
});

app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(express.json({ limit: "30kb" }));
app.use(express.static("public"));
app.use("/uploads", express.static(UPLOAD_DIR));
app.use(sessionMiddleware);

io.engine.use(sessionMiddleware);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12
});

function getUser(req) {
  if (!req.session.userId) return null;
  return findUserById.get(req.session.userId);
}

function requireLogin(req, res, next) {
  const user = getUser(req);

  if (!user) {
    return res.status(401).json({
      error: "Please log in first."
    });
  }

  req.user = user;
  next();
}

function developerAccount(username) {
  const developers = (
    process.env.DEV_USERNAMES || ""
  ).split(",").map(x => x.trim().toLowerCase());

  return developers.includes(username.toLowerCase());
}

function safeUser(user) {
  return {
    id: user.id,
    username: user.username,
    avatarUrl: user.avatar_url || null
  };
}

// EMAIL CONFIGURATION

let mailer = null;

if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
  mailer = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });
}

const hashCode = code =>
  crypto.createHash("sha256").update(code).digest("hex");

// CHECK LOGIN STATUS

app.get("/api/me", (req, res) => {
  const user = getUser(req);

  res.json({
    user: user ? safeUser(user) : null
  });
});

// CREATE ACCOUNT

app.post("/api/register", authLimiter, async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({
      error: "Username must be 3-20 characters."
    });
  }

  if (password.length < 8 || password.length > 72) {
    return res.status(400).json({
      error: "Password must be 8-72 characters."
    });
  }

  if (developerAccount(username)) {
    return res.status(403).json({
      error: "That username is reserved."
    });
  }

  if (findUser.get(username)) {
    return res.status(409).json({
      error: "Username already exists."
    });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = createUser.run(username, passwordHash);

    req.session.userId = Number(result.lastInsertRowid);

    res.json({
      user: safeUser(findUserById.get(req.session.userId))
    });
  } catch (error) {
    res.status(500).json({
      error: "Could not create account."
    });
  }
});

// LOGIN

app.post("/api/login", authLimiter, async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  const user = findUser.get(username);

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({
      error: "Incorrect username or password."
    });
  }

  if (developerAccount(user.username)) {
    if (!mailer) {
      return res.status(503).json({
        error: "Developer email verification is not configured."
      });
    }

    const code = String(
      crypto.randomInt(0, 1000000)
    ).padStart(6, "0");

    req.session.pending2FA = {
      userId: user.id,
      codeHash: hashCode(code),
      expiresAt: Date.now() + 300000,
      attempts: 0
    };

    try {
      await mailer.sendMail({
        from: process.env.GMAIL_USER,
        to: "jonasfinkle2012@gmail.com",
        subject: "WorldChat developer login",
        text: `Your verification code is ${code}. It expires in five minutes.`
      });

      return res.json({
        needsTwoFactor: true
      });
    } catch {
      delete req.session.pending2FA;

      return res.status(500).json({
        error: "Could not send verification email."
      });
    }
  }

  req.session.userId = user.id;

  res.json({
    user: safeUser(user)
  });
});

// VERIFY DEVELOPER LOGIN

app.post("/api/verify-2fa", authLimiter, (req, res) => {
  const pending = req.session.pending2FA;
  const code = String(req.body.code || "");

  if (
    !pending ||
    Date.now() > pending.expiresAt ||
    pending.attempts >= 5
  ) {
    delete req.session.pending2FA;

    return res.status(401).json({
      error: "Verification expired. Log in again."
    });
  }

  pending.attempts++;

  if (
    !/^\d{6}$/.test(code) ||
    hashCode(code) !== pending.codeHash
  ) {
    return res.status(401).json({
      error: "Incorrect verification code."
    });
  }

  req.session.userId = pending.userId;
  delete req.session.pending2FA;

  res.json({
    user: safeUser(findUserById.get(req.session.userId))
  });
});

// LOGOUT

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// PROFILE PICTURES

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, callback) => {
      callback(
        null,
        crypto.randomUUID() +
        path.extname(file.originalname).toLowerCase()
      );
    }
  }),
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (_req, file, callback) => {
    const allowed = [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif"
    ];

    callback(
      allowed.includes(file.mimetype)
        ? null
        : new Error("Unsupported image."),
      allowed.includes(file.mimetype)
    );
  }
});

app.post(
  "/api/avatar",
  requireLogin,
  upload.single("avatar"),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: "Select an image."
      });
    }

    const avatar = "/uploads/" + req.file.filename;

    db.prepare(
      "UPDATE users SET avatar_url = ? WHERE id = ?"
    ).run(avatar, req.user.id);

    res.json({ avatarUrl: avatar });
  }
);

// LOAD OLD MESSAGES

app.get("/api/messages", requireLogin, (req, res) => {
  const messages = db.prepare(`
    SELECT * FROM messages
    ORDER BY id DESC
    LIMIT 80
  `).all().reverse();

  res.json(messages);
});

// TENOR GIF SEARCH

app.get("/api/tenor", requireLogin, async (req, res) => {
  if (!process.env.TENOR_API_KEY) {
    return res.status(503).json({
      error: "Tenor API key is missing."
    });
  }

  const query = String(req.query.q || "").trim().slice(0, 80);

  if (!query) return res.json({ results: [] });

  try {
    const url = new URL(
      "https://tenor.googleapis.com/v2/search"
    );

    url.search = new URLSearchParams({
      q: query,
      key: process.env.TENOR_API_KEY,
      client_key: "worldchat",
      limit: "20",
      media_filter: "gif,tinygif",
      contentfilter: "medium"
    });

    const response = await fetch(url);

    if (!response.ok) throw new Error("Tenor failed");

    const data = await response.json();

    const results = (data.results || [])
      .map(item => ({
        id: item.id,
        title: item.content_description || "GIF",
        url: item.media_formats?.gif?.url
      }))
      .filter(item => item.url);

    res.json({ results });

  } catch {
    res.status(502).json({
      error: "GIF search failed."
    });
  }
});

// REAL-TIME CHAT

io.on("connection", socket => {
  const userId = socket.request.session?.userId;

  if (!userId) return socket.disconnect(true);

  socket.on("chat:send", payload => {
    const user = findUserById.get(userId);

    if (!user) return;

    const body = typeof payload?.body === "string"
      ? payload.body.trim().slice(0, 1000)
      : "";

    const gifUrl = typeof payload?.gifUrl === "string"
      ? payload.gifUrl
      : "";

    const validGif =
      /^https:\/\/(media\.tenor\.com|tenor\.com)\//i.test(gifUrl);

    if ((!body && !validGif) || (body && validGif)) return;

    db.prepare(`
      INSERT INTO messages
      (user_id, username, avatar_url, body, gif_url)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      user.id,
      user.username,
      user.avatar_url,
      body || null,
      validGif ? gifUrl : null
    );

    const message = db.prepare(
      "SELECT * FROM messages WHERE id = last_insert_rowid()"
    ).get();

    io.emit("chat:message", message);
  });
});

// WEBSITE

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// START SERVER

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be configured.");
}

server.listen(PORT, () => {
  console.log("WorldChat running on port " + PORT);
});
