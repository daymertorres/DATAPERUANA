/**
 * telegram.js — MTProto via teleproto
 * Incluye filtrado de mensajes de "procesando" para esperar la respuesta real del bot.
 */

const { TelegramClient } = require("teleproto");
const { StringSession } = require("teleproto/sessions");
const { NewMessage } = require("teleproto/events");
const input = require("input");
const fs = require("fs");
const path = require("path");

const SESSION_FILE = path.join(__dirname, "session.txt");
const DOWNLOADS_DIR = path.join(__dirname, "public", "downloads");
// En Vercel (serverless), el sistema de archivos es de solo lectura en produccion.
// Intentamos crear el dir, pero si falla (read-only) lo ignoramos; los medios
// seran servidos directamente desde memoria sin pasar por disco.
try { if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true }); } catch(e) {}

let client = null;
let targetGroup = null;
let botTarget = null;   // Entidad del bot para envio de comandos en privado
let botUserId = null;   // ID del bot para filtrar respuestas
let onNewMessageCallback = null;
let isConnecting = false;
let myUserId = null;

// Cola de consultas silenciosas
const silentMessageIds = new Set();
const pendingQueries = [];

// ── Detectar si un mensaje es de "procesando" (temporal) ──────
function isProcessingMessage(text) {
  if (!text || text.trim().length === 0) return false; // sin texto = podria ser el real
  const lower = text.toLowerCase();
  return (
    lower.includes("procesando") ||
    lower.includes("consultando") ||
    lower.includes("espera") ||
    lower.includes("buscando") ||
    lower.includes("cargando") ||
    lower.includes("aguarda") ||
    lower.includes("un momento") ||
    lower.includes("por favor") ||
    lower.includes("searching")
  );
}

// Verificar si el texto tiene datos reales (formato * CAMPO ➣ VALOR)
function isRealDataResponse(text) {
  if (!text) return false;
  const arrows = (text.match(/[➣»>]/g) || []).length;
  return arrows >= 2 || text.length > 150;
}

// ── Sesion ─────────────────────────────────────────────────────
// Prioridad de la sesion:
//   1. Variable de entorno SESSION_STRING (Vercel / produccion)
//   2. Archivo session.txt (desarrollo local)
function loadSession() {
  // 1. Desde variable de entorno (Vercel)
  if (process.env.SESSION_STRING && process.env.SESSION_STRING.trim()) {
    console.log("[Telegram] Sesion cargada desde variable de entorno SESSION_STRING.");
    return process.env.SESSION_STRING.trim();
  }
  // 2. Desde archivo local
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const s = fs.readFileSync(SESSION_FILE, "utf8").trim();
      if (s) { console.log("[Telegram] Sesion cargada desde session.txt."); return s; }
    }
  } catch (e) {}
  return "";
}
function saveSession(s) {
  // Siempre intentar guardar en archivo para desarrollo local
  try { fs.writeFileSync(SESSION_FILE, s, "utf8"); console.log("[Telegram] Sesion guardada en session.txt."); }
  catch (e) {
    // En Vercel el FS es read-only, esto es esperado
    if (e.code === "EROFS" || e.code === "EACCES") {
      console.log("[Telegram] FS read-only (Vercel). Sesion solo en memoria.");
      console.log("[Telegram] ======================================================");
      console.log("[Telegram] Copia esta cadena como SESSION_STRING en tus variables");
      console.log("[Telegram] de entorno de Vercel para persistir la sesion:");
      console.log(s);
      console.log("[Telegram] ======================================================");
    } else {
      console.error("[Telegram] Error guardando sesion:", e.message);
    }
  }
}

// ── Tipo de archivo ────────────────────────────────────────────
function getFileType(message) {
  if (!message.media) return "text";
  const media = message.media;
  if (media.className === "MessageMediaPhoto") return "photo";
  if (media.className === "MessageMediaDocument") {
    const doc = media.document;
    const mime = doc.mimeType || "";
    const attrs = doc.attributes || [];
    if (attrs.some(a => a.className === "DocumentAttributeVideo")) return "video";
    if (attrs.some(a => a.className === "DocumentAttributeAudio" || a.className === "DocumentAttributeVoice")) return "audio";
    if (mime.startsWith("image/")) return "image";
    if (mime === "application/pdf") return "pdf";
    if (mime.includes("word") || mime.includes("document")) return "word";
    if (mime.includes("excel") || mime.includes("spreadsheet")) return "excel";
    if (mime.includes("powerpoint") || mime.includes("presentation")) return "powerpoint";
    if (mime.includes("zip") || mime.includes("rar")) return "zip";
    return "document";
  }
  return "text";
}

function getFileName(message) {
  if (!message.media) return null;
  if (message.media.className === "MessageMediaDocument") {
    const fn = (message.media.document.attributes || []).find(a => a.className === "DocumentAttributeFilename");
    if (fn) return fn.fileName;
    return "archivo_" + message.id;
  }
  if (message.media.className === "MessageMediaPhoto") return "foto_" + message.id + ".jpg";
  return null;
}

async function serializeMessage(message) {
  const sender = message.sender;
  let senderName = "Usuario";
  if (sender) {
    if (sender.firstName || sender.lastName) senderName = [sender.firstName, sender.lastName].filter(Boolean).join(" ");
    else if (sender.title) senderName = sender.title;
    else if (sender.username) senderName = "@" + sender.username;
  }
  const fileType = getFileType(message);
  return {
    id: message.id,
    text: message.message || "",
    senderName,
    senderId: sender ? String(sender.id) : null,
    isOwn: myUserId && sender ? String(sender.id) === String(myUserId) : false,
    date: message.date * 1000,
    fileType,
    fileName: getFileName(message),
    hasMedia: !!message.media,
    downloadUrl: message.media ? "/api/download/" + message.id : null,
  };
}

// ── Conectar ───────────────────────────────────────────────────
// Errores que NO deben reintentar (config incorrecta, no de red)
const FATAL_ERRORS = ["API ID invalid", "API_ID_INVALID", "PHONE_NUMBER_INVALID", "AUTH_KEY_INVALID", "cannot be empty"];
function isFatalError(msg) { return FATAL_ERRORS.some(e => msg && msg.includes(e)); }

async function connect(apiId, apiHash, phoneNumber) {
  if (isConnecting) { console.log("[Telegram] Ya conectando..."); return false; }
  isConnecting = true;
  const session = new StringSession(loadSession());
  client = new TelegramClient(session, parseInt(apiId, 10), apiHash, {
    connectionRetries: 3, retryDelay: 3000, autoReconnect: false, useWSS: false,
  });
  try {
    await client.start({
      phoneNumber: async () => phoneNumber,
      password: async () => { console.log("[Telegram] 2FA requerida:"); return await input.text("Contrasena 2FA: "); },
      phoneCode: async () => { console.log("[Telegram] Codigo enviado al telefono."); return await input.text("Codigo de verificacion: "); },
      onError: (err) => {
        console.error("[Telegram] Error auth:", err.message);
        if (isFatalError(err.message)) throw err; // detener reintentos
      },
    });
    saveSession(client.session.save());
    const me = await client.getMe();
    myUserId = String(me.id);
    console.log("[Telegram] Conectado como:", me.firstName, me.lastName || "");
    isConnecting = false;
    return true;
  } catch (err) {
    console.error("[Telegram] Error de conexion:", err.message);
    isConnecting = false;
    // Solo reintenta si NO es error fatal de configuracion
    if (!isFatalError(err.message)) {
      scheduleReconnect(apiId, apiHash, phoneNumber);
    } else {
      console.error("[Telegram] Error fatal — revisa API_ID, API_HASH y PHONE_NUMBER en .env");
    }
    return false;
  }
}

async function resolveGroup(groupIdentifier) {
  let entity;
  if (/^-?\d+$/.test(groupIdentifier)) entity = await client.getEntity(parseInt(groupIdentifier));
  else entity = await client.getEntity(groupIdentifier.startsWith("@") ? groupIdentifier : "@" + groupIdentifier);
  targetGroup = entity;
  console.log("[Telegram] Grupo resuelto:", entity.title, "(ID:", entity.id + ")");
  return entity;
}

// Resuelve el bot para envio de comandos en privado
async function resolveBot(botUsername) {
  if (!botUsername) return null;
  const username = botUsername.startsWith("@") ? botUsername.slice(1) : botUsername;
  try {
    const entity = await client.getEntity("@" + username);
    botTarget = entity;
    botUserId = String(entity.id);
    console.log("[Telegram] Bot resuelto:", entity.username || entity.firstName, "(ID:", entity.id + ") — comandos en PRIVADO");
    return entity;
  } catch (err) {
    console.error("[Telegram] No se pudo resolver el bot:", err.message);
    return null;
  }
}

async function getMessages(limit) {
  if (!client || !targetGroup) throw new Error("No inicializado");
  const msgs = await client.getMessages(targetGroup, { limit: limit || 50 });
  return Promise.all(msgs.reverse().map(m => serializeMessage(m)));
}

async function downloadFile(messageId) {
  if (!client || !targetGroup) throw new Error("No inicializado");
  const msgId = parseInt(messageId);

  // Buscar primero en el chat privado del bot (donde llegan las respuestas ahora)
  // y luego en el grupo como fallback
  const searchTargets = botTarget ? [botTarget, targetGroup] : [targetGroup];

  let message = null;
  for (const target of searchTargets) {
    try {
      const msgs = await client.getMessages(target, { ids: [msgId] });
      if (msgs && msgs.length > 0 && msgs[0] && msgs[0].media) {
        message = msgs[0];
        console.log("[Telegram] Archivo encontrado en:", botTarget && target === botTarget ? "chat privado bot" : "grupo");
        break;
      }
    } catch (e) { /* intentar siguiente */ }
  }

  if (!message) throw new Error("Mensaje no encontrado");
  if (!message.media) throw new Error("Sin adjunto");

  const fileName = getFileName(message) || "archivo_" + messageId;
  const buffer = await client.downloadMedia(message.media, {
    progressCallback: (r, t) => { if (t > 0) process.stdout.write("\r[Telegram] " + Math.round(r/t*100) + "%"); }
  });
  console.log("\n[Telegram] Descarga completa:", fileName);

  // Detectar mimeType: fotos (MessageMediaPhoto) no tienen document
  let mimeType = "application/octet-stream";
  if (message.media.className === "MessageMediaPhoto") {
    mimeType = "image/jpeg";
  } else if (message.media.document && message.media.document.mimeType) {
    mimeType = message.media.document.mimeType;
  }

  return { buffer, fileName, mimeType };
}


async function sendMessage(text) {
  if (!client || !targetGroup) throw new Error("No inicializado");
  const sendTarget = botTarget || targetGroup;
  const result = await client.sendMessage(sendTarget, { message: text.trim() });
  return serializeMessage(result);
}

// ── Enviar comando silencioso y esperar respuesta REAL del bot ─
async function sendCommandAndWait(command, options) {
  if (!client || !targetGroup) throw new Error("No conectado");
  const timeoutMs = (options && options.timeoutMs) || 30000;
  const waitForMedia = !!(options && options.waitForMedia);

  // Si hay bot configurado en privado, enviar ahi; si no, al grupo
  const sendTarget = botTarget || targetGroup;
  const sendMode = botTarget ? "privado con bot" : "grupo";

  return new Promise(async (resolve, reject) => {
    const entry = {
      resolve, reject, waitForMedia,
      messages: [], collectTimer: null, settled: false, timer: null,
      skipped: 0,
    };

    entry.timer = setTimeout(() => {
      if (entry.settled) return;
      entry.settled = true;
      const idx = pendingQueries.indexOf(entry);
      if (idx !== -1) pendingQueries.splice(idx, 1);
      reject(new Error("Tiempo agotado. El bot no respondio en " + (timeoutMs/1000) + "s."));
    }, timeoutMs);

    pendingQueries.push(entry);

    try {
      const sent = await client.sendMessage(sendTarget, { message: command.trim() });
      if (sent && sent.id) silentMessageIds.add(sent.id);
      console.log("[Telegram] Comando [" + sendMode + "]:", command.substring(0, 40));
    } catch (err) {
      if (!entry.settled) {
        entry.settled = true;
        clearTimeout(entry.timer);
        const idx = pendingQueries.indexOf(entry);
        if (idx !== -1) pendingQueries.splice(idx, 1);
        reject(err);
      }
    }
  });
}

// ── Listener en tiempo real ────────────────────────────────────
function listenForNewMessages(callback) {
  if (!client || !targetGroup) return;
  onNewMessageCallback = callback;

  client.addEventHandler(async (event) => {
    try {
      const message = event.message;
      const peerId = message.peerId;
      let msgGroupId = null;
      let isBotPrivateMsg = false;

      if (peerId.className === "PeerChannel") msgGroupId = peerId.channelId;
      else if (peerId.className === "PeerChat") msgGroupId = peerId.chatId;
      else if (peerId.className === "PeerUser" && botUserId) {
        // Mensaje privado — puede ser del bot o comando propio enviado al bot
        isBotPrivateMsg = String(peerId.userId) === String(botUserId);
      }

      // Aceptar: mensajes del grupo O mensajes privados del bot
      if (!isBotPrivateMsg && String(msgGroupId) !== String(targetGroup.id)) return;

      await message.getSender();
      const isOwn = myUserId && message.sender && String(message.sender.id) === String(myUserId);
      const msgText = message.message || "";
      const hasMedia = !!message.media;

      // Filtrar mensaje silencioso propio (comando enviado)
      if (isOwn && silentMessageIds.has(message.id)) {
        silentMessageIds.delete(message.id);
        return;
      }

      // Interceptar respuesta del bot para consulta pendiente
      if (!isOwn && pendingQueries.length > 0) {
        const entry = pendingQueries[0];
        if (entry.settled) { pendingQueries.shift(); }
        else if (entry.waitForMedia) {
          // Modo media (AGV): saltar mensajes de "procesando" y esperar el real
          if (isProcessingMessage(msgText)) {
            entry.skipped++;
            console.log("[Telegram] AGV: Saltando mensaje de procesando (" + entry.skipped + "):", msgText.substring(0, 60));
            return; // no broadcast, seguir esperando
          }
          if (hasMedia) {
            entry.messages.push(message);
            console.log("[Telegram] AGV: Media recibida, colectando...");
              if (!entry.collectTimer) {
                entry.collectTimer = setTimeout(async () => {
                  if (entry.settled) return;
                  const idx = pendingQueries.indexOf(entry);
                  if (idx !== -1) pendingQueries.splice(idx, 1);
                  clearTimeout(entry.timer);
                  entry.settled = true;

                  const mediaItems = [];
                  for (const m of entry.messages) {
                    if (m.media) {
                      const serialized = await serializeMessage(m);
                      mediaItems.push(serialized);
                    }
                  }
                  console.log("[Telegram] AGV: Respuesta resuelta con", mediaItems.length, "media(s)");
                  entry.resolve({ type: "media_group", messages: mediaItems });
                }, 5000); // Aumentado a 5s para colectar TODOS los PDFs/album completo
              }
              return;
          }
          // Texto sin "procesando" y sin media: podria ser mensaje intermedio, saltarlo
          return;
        } else {
          // Modo texto (DNI): saltar mensajes de "procesando" o sin datos reales
          if (isProcessingMessage(msgText)) {
            entry.skipped++;
            console.log("[Telegram] DNI: Saltando mensaje de procesando (" + entry.skipped + "):", msgText.substring(0, 60));
            return;
          }
          if (!msgText && hasMedia) {
            // Solo media sin texto en modo texto - es el thumbnail de procesando
            entry.skipped++;
            console.log("[Telegram] DNI: Saltando media sin texto (" + entry.skipped + ")");
            return;
          }

          // Tiene texto que no es de procesando - colectar y resolver
          entry.messages.push(message);
          console.log("[Telegram] DNI: Mensaje de datos recibido, colectando...");

          // Resetear el timer en cada mensaje nuevo (debounce)
          if (entry.collectTimer) clearTimeout(entry.collectTimer);

          entry.collectTimer = setTimeout(async () => {
            if (entry.settled) return;
            const idx = pendingQueries.indexOf(entry);
            if (idx !== -1) pendingQueries.splice(idx, 1);
            clearTimeout(entry.timer);
            entry.settled = true;
            const mainMsg = entry.messages.find(m => m.message && m.message.length > 20) || entry.messages[0];
            const mediaMsg = entry.messages.find(m => m.media) || mainMsg;
            
            const serializedMain = await serializeMessage(mainMsg);
            const serializedMedia = mediaMsg !== mainMsg ? await serializeMessage(mediaMsg) : serializedMain;

            entry.resolve({
              type: "text",
              message: {
                ...serializedMain,
                hasMedia: serializedMedia.hasMedia,
                downloadUrl: serializedMedia.downloadUrl,
                fileType: serializedMedia.fileType
              },
              text: entry.messages.map(m => m.message || "").join("\n").trim(),
            });
          }, 2500); // 2.5s desde el ULTIMO mensaje recibido
          return;
        }
      }

      // Broadcast normal (no hay consulta pendiente)
      const serialized = await serializeMessage(message);
      console.log("[Telegram]", serialized.senderName + ":", (serialized.text || "[archivo]").substring(0, 60));
      if (onNewMessageCallback) onNewMessageCallback(serialized);

    } catch (err) {
      console.error("[Telegram] Error en listener:", err.message);
    }
  }, new NewMessage({}));

  console.log("[Telegram] Escuchando mensajes en tiempo real...");
}

let reconnectAttempts = 0;
let reconnectTimer = null;
function scheduleReconnect(apiId, apiHash, phoneNumber) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectAttempts++;
  const delay = Math.min(5000 * reconnectAttempts, 60000);
  console.log("[Telegram] Reconectando en", delay/1000 + "s...");
  reconnectTimer = setTimeout(async () => {
    const ok = await connect(apiId, apiHash, phoneNumber);
    if (ok) { reconnectAttempts = 0; await resolveGroup(process.env.TARGET_GROUP); listenForNewMessages(onNewMessageCallback); }
  }, delay);
}

function isConnected() { return client && client.connected; }
function getMyUserId() { return myUserId; }
function getBotUserId() { return botUserId; }
// Retorna la cadena de sesion actual (util para copiarla como SESSION_STRING)
function getSessionString() { return client ? client.session.save() : ""; }

module.exports = {
  connect, resolveGroup, resolveBot, getMessages, downloadFile,
  sendMessage, sendCommandAndWait,
  listenForNewMessages, isConnected, getMyUserId, getBotUserId, getSessionString,
};
