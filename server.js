const express    = require("express");
const cors       = require("cors");
const { v4: uuidv4 } = require("uuid");
const path       = require("path");
const http       = require("http");
const { Server } = require("socket.io");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: "*", methods: ["GET","POST","DELETE"] }
});

const PORT        = process.env.PORT || 7860;
const POST_TTL_MS = 2 * 60 * 60 * 1000;   // 2 hours
const BUMP_CD_MS  = 15 * 60 * 1000;        // 15 minutes

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── In-memory store ──────────────────────────────────────────────────────────
let posts = [];

// ─── Auto-deletion: sweep every 5 minutes ────────────────────────────────────
setInterval(() => {
  const before = posts.length;
  posts = posts.filter((p) => Date.now() - p.createdAt < POST_TTL_MS);
  const removed = before - posts.length;
  if (removed > 0) {
    console.log(`[cleanup] Removed ${removed} expired post(s).`);
    io.emit("feed:refresh", getSortedPosts());
  }
}, 5 * 60 * 1000);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getSortedPosts() {
  return posts
    .filter((p) => Date.now() - p.createdAt < POST_TTL_MS)
    .sort((a, b) => b.bumpedAt - a.bumpedAt);
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[socket] client connected: ${socket.id}`);
  socket.on("disconnect", () => console.log(`[socket] client left: ${socket.id}`));
});

// ─── Routes ───────────────────────────────────────────────────────────────────

/** GET /api/posts */
app.get("/api/posts", (_req, res) => {
  res.json(getSortedPosts());
});

/** POST /api/posts — create */
app.post("/api/posts", (req, res) => {
  const { game, matchType, rank, playersNeeded, discord, tags } = req.body;

  if (!game || !matchType || !playersNeeded || !discord) {
    return res.status(400).json({ error: "Missing required fields." });
  }
  if (!["ranked", "casual"].includes(matchType)) {
    return res.status(400).json({ error: "Invalid matchType." });
  }
  const playersNum = parseInt(playersNeeded, 10);
  if (isNaN(playersNum) || playersNum < 1 || playersNum > 9) {
    return res.status(400).json({ error: "playersNeeded must be 1-9." });
  }
  const validTags = ["mic", "tryhard", "chill"];
  const sanitizedTags = Array.isArray(tags)
    ? tags.filter((t) => validTags.includes(t))
    : [];

  const now  = Date.now();
  const post = {
    id: uuidv4(),
    game: game.trim(),
    matchType,
    rank: matchType === "ranked" ? (rank || "").trim() : null,
    playersNeeded: playersNum,
    discord: discord.trim(),
    tags: sanitizedTags,
    createdAt: now,
    bumpedAt:  now,
    lastBump:  0,   // epoch of last bump (0 = never)
  };

  posts.unshift(post);
  console.log(`[new post] ${post.game} | ${post.matchType} | ${post.discord}`);

  // Broadcast to all clients
  io.emit("post:new", post);

  res.status(201).json(post);
});

/** POST /api/posts/:id/bump — bump a post */
app.post("/api/posts/:id/bump", (req, res) => {
  const post = posts.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: "Post not found." });

  const now = Date.now();
  if (now - post.lastBump < BUMP_CD_MS) {
    const secsLeft = Math.ceil((BUMP_CD_MS - (now - post.lastBump)) / 1000);
    return res.status(429).json({ error: "Too soon.", secsLeft });
  }

  post.bumpedAt = now;
  post.lastBump = now;

  // Re-sort: remove and unshift so it's first
  posts = posts.filter((p) => p.id !== post.id);
  posts.unshift(post);

  io.emit("post:bumped", post);
  console.log(`[bump] ${post.game} | ${post.discord}`);
  res.json(post);
});

/** DELETE /api/posts/:id */
app.delete("/api/posts/:id", (req, res) => {
  const idx = posts.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Post not found." });
  const [removed] = posts.splice(idx, 1);
  io.emit("post:deleted", removed.id);
  res.json({ ok: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🎮  PairUp Server running → http://localhost:${PORT}\n`);
});
