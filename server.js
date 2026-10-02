/**
 * server.js — Express + Socket.IO
 * API REST + WebSocket + Consultas silenciosas al bot @onixdataa_bot
 * Comandos: /dni, /nm, /telx, /tels, /actana, /denuncias
 */
require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const telegram = require("./telegram");

const PORT = process.env.PORT || 3000;
const API_ID = process.env.API_ID;
const API_HASH = process.env.API_HASH;
const PHONE_NUMBER = process.env.PHONE_NUMBER;
const TARGET_GROUP = process.env.TARGET_GROUP;
const BOT_USERNAME = process.env.BOT_USERNAME || "@onixdataa_bot";

if (!API_ID || !API_HASH || !PHONE_NUMBER || !TARGET_GROUP) {
  console.error("Faltan variables de entorno en .env"); process.exit(1);
}

const IS_PROD = process.env.NODE_ENV === "production";

const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
  process.env.FRONTEND_URL || null,
].filter(Boolean);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: IS_PROD ? ALLOWED_ORIGINS : "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["polling", "websocket"],
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(cors({
  origin: IS_PROD ? ALLOWED_ORIGINS : "*",
  credentials: true,
}));

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Multer en memoria para fotos de búsqueda facial
const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB máx
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Solo se permiten imágenes."), false);
  },
});

let telegramReady = false;
let connectionStatus = "connecting";
let groupInfo = { name: "Cargando...", id: null };

// ── Parsear respuesta DNI ──────────────────────────────────────
function parseDniResponse(text) {
  if (!text) return {};
  const data = {
    nacimiento: {},
    info: {},
    domicilio: {},
    raw: text
  };

  const extr = (patterns) => {
    for (const p of patterns) {
      const m = text.match(p);
      if (m && m[1]) return m[1].trim();
    }
    return null;
  };

  data.dni = extr([/DNI\s*[➣:»>-]\s*(\d{8})/i, /N[°º]\s*(\d{8})/]);
  data.nombres = extr([/NOMBRES?\s*[➣:»>-]\s*([^\n\r]+)/i]);
  data.apellidos = extr([/APELLIDOS?\s*[➣:»>-]\s*([^\n\r]+)/i]);
  data.nombreCompleto = data.nombres && data.apellidos ? `${data.apellidos} ${data.nombres}` : null;
  data.genero = extr([/G[ÉE]NERO\s*[➣:»>-]\s*([^\n\r]+)/i]);
  if (!data.genero) {
    if (/MASCULINO/i.test(text)) data.genero = "Masculino";
    else if (/FEMENINO/i.test(text)) data.genero = "Femenino";
  }

  data.nacimiento.fecha = extr([/FECHA.{0,10}NACIMIENTO\s*[➣:»>-]\s*([^\n\r]+)/i]);
  data.nacimiento.edad = extr([/EDAD\s*[➣:»>-]\s*([^\n\r]+)/i]);

  const deptMatch = text.match(/DEPARTAMENTO\s*[➣:»>-]\s*([^\n\r]+)/ig);
  const provMatch = text.match(/PROVINCIA\s*[➣:»>-]\s*([^\n\r]+)/ig);
  const distMatch = text.match(/DISTRITO\s*[➣:»>-]\s*([^\n\r]+)/ig);

  if (deptMatch && deptMatch[0]) data.nacimiento.departamento = deptMatch[0].replace(/DEPARTAMENTO\s*[➣:»>-]\s*/i, "").trim();
  if (provMatch && provMatch[0]) data.nacimiento.provincia = provMatch[0].replace(/PROVINCIA\s*[➣:»>-]\s*/i, "").trim();
  if (distMatch && distMatch[0]) data.nacimiento.distrito = distMatch[0].replace(/DISTRITO\s*[➣:»>-]\s*/i, "").trim();

  data.info.estadoCivil = extr([/ESTADO.{0,6}CIVIL\s*[➣:»>-]\s*([^\n\r]+)/i]);
  data.info.fechaEmision = extr([/FECHA.{0,6}EMISI[ÓO]N\s*[➣:»>-]\s*([^\n\r]+)/i]);
  data.info.fechaCaducidad = extr([/FECHA.{0,6}CADUCIDAD\s*[➣:»>-]\s*([^\n\r]+)/i]);
  data.info.padre = extr([/PADRE\s*[➣:»>-]\s*([^\n\r]+)/i]);
  data.info.madre = extr([/MADRE\s*[➣:»>-]\s*([^\n\r]+)/i]);

  if (deptMatch && deptMatch[1]) data.domicilio.departamento = deptMatch[1].replace(/DEPARTAMENTO\s*[➣:»>-]\s*/i, "").trim();
  if (provMatch && provMatch[1]) data.domicilio.provincia = provMatch[1].replace(/PROVINCIA\s*[➣:»>-]\s*/i, "").trim();
  if (distMatch && distMatch[1]) data.domicilio.distrito = distMatch[1].replace(/DISTRITO\s*[➣:»>-]\s*/i, "").trim();
  data.domicilio.direccion = extr([/DIRECCI[ÓO]N\s*[➣:»>-]\s*([^\n\r]+)/i]);

  data.estado = "ACTIVO";
  return data;
}

// ── API: Status ──────────────────────────────────────────────────
app.get("/api/status", (req, res) => {
  res.json({ status: connectionStatus, group: groupInfo, connected: telegram.isConnected(), myUserId: telegram.getMyUserId() });
});

// ── API: Session string (solo dev) ─────────────────────────────
app.get("/api/session-string", (req, res) => {
  if (IS_PROD) return res.status(403).json({ error: "No disponible en produccion." });
  const s = telegram.getSessionString();
  if (!s) return res.status(503).json({ error: "Telegram no conectado o sin sesion." });
  res.json({ ok: true, sessionString: s });
});

// ── Helpers ─────────────────────────────────────────────────────
function validateDni(dni) {
  return dni && /^\d{7,9}$/.test(String(dni).trim());
}

function mediaResponse(result) {
  if (result.type === "media_group") {
    return { ok: true, mediaGroup: result.messages.map(m => ({ downloadUrl: m.downloadUrl, fileType: m.fileType, fileName: m.fileName, messageId: m.id })) };
  } else if (result.type === "media") {
    const m = result.message;
    return { ok: true, mediaGroup: [{ downloadUrl: m.downloadUrl, fileType: m.fileType, fileName: m.fileName, messageId: m.id }] };
  } else {
    return { ok: true, text: result.text || "Respuesta recibida." };
  }
}

// ── API: Consulta DNI (/dni XXXXXXXX) ────────────────────────
app.post("/api/query/dni", async (req, res) => {
  if (!telegramReady) return res.status(503).json({ error: "Telegram no conectado." });
  const { dni } = req.body;
  if (!validateDni(dni)) return res.status(400).json({ error: "DNI invalido. Debe tener 8 digitos." });
  const dniClean = String(dni).trim();
  console.log("[API] Consulta DNI:", dniClean);
  try {
    const result = await telegram.sendCommandAndWait(`/dni ${dniClean}`, { timeoutMs: 30000, waitForMedia: false });
    const parsed = parseDniResponse(result.text || "");
    if (!parsed.dni) parsed.dni = dniClean;
    res.json({ ok: true, data: parsed, raw: result.text, photoUrl: result.message?.downloadUrl || null });
  } catch (err) {
    console.error("[API] Error DNI:", err.message);
    res.status(504).json({ error: err.message });
  }
});

// ── API: Búsqueda por Nombre (/nm) ───────────────────────────
app.post("/api/query/nm", async (req, res) => {
  if (!telegramReady) return res.status(503).json({ error: "Telegram no conectado." });
  const { nombres, apellidoPat, apellidoMat } = req.body;
  if (!nombres || !apellidoPat) return res.status(400).json({ error: "Nombre y apellido paterno requeridos." });
  const cmd = `/nm ${String(nombres).trim()}|${String(apellidoPat).trim()}|${String(apellidoMat || "").trim()}`;
  console.log("[API] Consulta NM:", cmd.substring(0, 60));
  try {
    const result = await telegram.sendCommandAndWait(cmd, { timeoutMs: 35000, waitForMedia: false });
    res.json({ ok: true, raw: result.text, text: result.text });
  } catch (err) {
    console.error("[API] Error NM:", err.message);
    res.status(504).json({ error: err.message });
  }
});

// ── API: Titular por Celular (/telx XXXXXXXXX) ───────────────
app.post("/api/query/telx", async (req, res) => {
  if (!telegramReady) return res.status(503).json({ error: "Telegram no conectado." });
  const { dni } = req.body; // reutilizamos campo "dni" para el celular
  const cel = String(dni || "").trim();
  if (!cel || !/^\d{9}$/.test(cel)) return res.status(400).json({ error: "Numero de celular invalido. Debe tener 9 digitos." });
  console.log("[API] Consulta TELX:", cel);
  try {
    const result = await telegram.sendCommandAndWait(`/telx ${cel}`, { timeoutMs: 30000, waitForMedia: false });
    res.json({ ok: true, text: result.text });
  } catch (err) {
    console.error("[API] Error TELX:", err.message);
    res.status(504).json({ error: err.message });
  }
});

// ── API: Líneas por DNI (/tels XXXXXXXX) ─────────────────────
app.post("/api/query/tels", async (req, res) => {
  if (!telegramReady) return res.status(503).json({ error: "Telegram no conectado." });
  const { dni } = req.body;
  if (!validateDni(dni)) return res.status(400).json({ error: "DNI invalido." });
  const dniClean = String(dni).trim();
  console.log("[API] Consulta TELS:", dniClean);
  try {
    const result = await telegram.sendCommandAndWait(`/tels ${dniClean}`, { timeoutMs: 30000, waitForMedia: false });
    res.json({ ok: true, text: result.text });
  } catch (err) {
    console.error("[API] Error TELS:", err.message);
    res.status(504).json({ error: err.message });
  }
});

// ── API: Acta de Nacimiento (/actana XXXXXXXX) ───────────────
app.post("/api/query/actana", async (req, res) => {
  if (!telegramReady) return res.status(503).json({ error: "Telegram no conectado." });
  const { dni } = req.body;
  if (!validateDni(dni)) return res.status(400).json({ error: "DNI invalido." });
  const dniClean = String(dni).trim();
  console.log("[API] Consulta ACTANA:", dniClean);
  try {
    const result = await telegram.sendCommandAndWait(`/actana ${dniClean}`, { timeoutMs: 45000, waitForMedia: true });
    res.json(mediaResponse(result));
  } catch (err) {
    console.error("[API] Error ACTANA:", err.message);
    res.status(504).json({ error: err.message });
  }
});

// ── API: Denuncias Penales (/denuncias XXXXXXXX) ─────────────
app.post("/api/query/denuncias", async (req, res) => {
  if (!telegramReady) return res.status(503).json({ error: "Telegram no conectado." });
  const { dni } = req.body;
  if (!validateDni(dni)) return res.status(400).json({ error: "DNI invalido." });
  const dniClean = String(dni).trim();
  console.log("[API] Consulta DENUNCIAS:", dniClean);
  try {
    const result = await telegram.sendCommandAndWait(`/denuncias ${dniClean}`, { timeoutMs: 45000, waitForMedia: true });
    res.json(mediaResponse(result));
  } catch (err) {
    console.error("[API] Error DENUNCIAS:", err.message);
    res.status(504).json({ error: err.message });
  }
});

// ── API: Búsqueda Facial (/facial + foto) ─────────────────────
app.post("/api/query/facial", uploadMemory.single("photo"), async (req, res) => {
  if (!telegramReady) return res.status(503).json({ error: "Telegram no conectado." });
  if (!req.file) return res.status(400).json({ error: "No se recibió ninguna imagen." });
  console.log("[API] Búsqueda FACIAL: imagen recibida", req.file.originalname, req.file.size, "bytes");
  try {
    const result = await telegram.sendPhotoAndWait(
      req.file.buffer,
      req.file.mimetype,
      { timeoutMs: 60000 }
    );
    res.json(mediaResponse(result));
  } catch (err) {
    console.error("[API] Error FACIAL:", err.message);
    res.status(504).json({ error: err.message });
  }
});

// Error handler de multer
app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "La imagen supera los 15 MB." });
  if (err.message) return res.status(400).json({ error: err.message });
  next(err);
});

// ── API: Descarga ──────────────────────────────────────────────
app.get("/api/download/:messageId", async (req, res) => {
  if (!telegramReady) return res.status(503).json({ error: "No conectado." });
  try {
    const { buffer, fileName, mimeType } = await telegram.downloadFile(req.params.messageId);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", buffer.length);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Preview inline ────────────────────────────────────────
app.get("/api/preview/:messageId", async (req, res) => {
  if (!telegramReady) return res.status(503).send("No conectado");
  try {
    const { buffer, mimeType, fileName } = await telegram.downloadFile(req.params.messageId);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(fileName || "archivo")}"`);
    res.setHeader("Content-Type", mimeType || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(buffer);
  } catch (err) {
    console.error("[API] Error al generar preview de", req.params.messageId, ":", err);
    res.status(500).send("Error al cargar archivo");
  }
});

// ── Socket.IO ──────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("[Socket.IO] Cliente conectado:", socket.id);
  socket.emit("status", { status: connectionStatus, group: groupInfo });
  socket.on("disconnect", () => console.log("[Socket.IO] Cliente desconectado:", socket.id));
});

function broadcastStatus(status, extra) { io.emit("status", { status, ...(extra || {}) }); }

// ── Init Telegram ──────────────────────────────────────────────
async function initTelegram() {
  console.log("\n ONIXDATA — Iniciando sistema de consulta...");
  console.log(" Bot configurado: " + BOT_USERNAME);
  try {
    const connected = await telegram.connect(API_ID, API_HASH, PHONE_NUMBER);
    if (!connected) { connectionStatus = "error"; broadcastStatus("error", { message: "No se pudo conectar." }); return; }
    const group = await telegram.resolveGroup(TARGET_GROUP);
    groupInfo = { name: group.title || TARGET_GROUP, id: String(group.id), username: group.username || null };
    if (BOT_USERNAME) {
      await telegram.resolveBot(BOT_USERNAME);
    } else {
      console.log("[Server] BOT_USERNAME no configurado.");
    }
    telegramReady = true;
    connectionStatus = "ready";
    broadcastStatus("ready", { group: groupInfo });
    telegram.listenForNewMessages(() => {});
    console.log("\n Sistema listo: http://localhost:" + PORT + "\n");
  } catch (err) {
    console.error("Error init:", err.message);
    connectionStatus = "error";
    broadcastStatus("error", { message: err.message });
  }
}

server.listen(PORT, async () => {
  console.log("[Server] Escuchando en http://localhost:" + PORT);
  await initTelegram();
});

process.on("unhandledRejection", (r) => console.error("[Server] Promesa sin manejar:", r));
process.on("uncaughtException", (e) => console.error("[Server] Excepcion:", e.message));
