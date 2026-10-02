/**
 * app.js — ONIXDATA Sistema de Consulta
 * SPA limpia sin login/auth/admin. Bot: @onixdataa_bot
 * Comandos: /dni, /nm, /telx, /tels, /actana, /denuncias
 */
"use strict";

// ── Estado global ─────────────────────────────────────────────
const state = {
  currentView: "dashboard",
  recentDnis: JSON.parse(localStorage.getItem("recentDnis") || "[]"),
  socket: null,
};

// ── Utilidades ────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function esc(s) {
  if (!s) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ── Limpiar texto del bot (quitar símbolos, @, emojis decorativos) ─────────
function cleanBotText(text) {
  if (!text) return "";
  if (isJunkResponse(text)) return null;
  return text
    .replace(/@\w+/g, "")
    .replace(/[➣»►▸•·★☆✓✗✦▶◀]/g, "") // quitarlos totalmente para diseño limpio
    .replace(/➟/g, "")                // quitar flecha bot
    .replace(/[🔴🟢🔵🟣🟡🟠⬛⬜]/g, "")
    .replace(/[🎉🎊🎯🔥💥⚡🚀]/g, "")
    .replace(/\[\s*ᴘᴇʀsᴏɴᴀ ʜᴀʟʟᴀᴅᴀ.*\]/gi, "") // quitar cabecera molesta
    .replace(/RESULTADO DE BÚSQUEDA/gi, "")    // quitar cabecera redundante
    .replace(/_{2,}/g, " ")
    .replace(/\*{2,}/g, "")
    .replace(/-?\s*N\/A/gi, "")      // quitar los N/A
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Detectar respuestas basura/antispam del bot ───────────────
function isJunkResponse(text) {
  if (!text || text.trim().length === 0) return true;
  const t = text.trim().toLowerCase();
  if (t.length < 15 && !/\d{6,}/.test(t)) return true;
  const junkPatterns = [/anti.?spam/i, /flood/i, /demasiado.?(rapido|veloz|fast)/i, /espera.+\d+.+segundo/i, /wait.+second/i, /rate.?limit/i, /por favor espera/i, /intenta.+m[aá]s.+tarde/i, /try again later/i, /\[pm\]/i, /premium/i, /compra/i, /adquiere/i];
  const stripped = t.replace(/@\w+/g,"").replace(/[^a-z0-9\s]/g,"").trim();
  if (stripped.length < 5) return true;
  return junkPatterns.some(p => p.test(text));
}

function showToast(msg, type = "info", dur = 3500) {
  const icons = { info:"ph-info", success:"ph-check-circle", error:"ph-warning-circle" };
  const t = document.createElement("div");
  t.className = "toast " + type;
  t.innerHTML = `<i class="ph ${icons[type]||"ph-info"}"></i><span>${esc(msg)}</span>`;
  const container = $("toast-container");
  if (container) container.appendChild(t);
  setTimeout(() => { t.style.transition="all .3s"; t.style.opacity="0"; t.style.transform="translateX(40px)"; setTimeout(()=>t.remove(),320); }, dur);
}

function setLoading(btnId, isLoading) {
  const btn = $(btnId);
  if (!btn) return;
  btn.disabled = isLoading;
  if (isLoading) {
    btn._origHTML = btn.innerHTML;
    btn.innerHTML = `<span class="spinner" style="width:18px;height:18px;border-width:2px"></span> Consultando...`;
  } else if (btn._origHTML) {
    btn.innerHTML = btn._origHTML;
  }
}

// ── Animación de carga en el modal ────────────────────────────
function showResultLoading(panelId, label = "Consultando datos...") {
  const modal = $("rmodal");
  const body  = $("rmodal-body");
  const title = $("rmodal-title");
  if (modal && body) {
    modal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    if (title) title.textContent = "Consultando...";
    body.innerHTML = `
      <div class="query-loading">
        <div class="loading-orb">
          <div class="loading-orb-ring"></div>
          <div class="loading-orb-ring r2"></div>
          <div class="loading-orb-core"><i class="ph ph-identification-card"></i></div>
        </div>
        <p>${esc(label)}</p>
        <small class="loading-sub">Conectando con @onixdataa_bot...</small>
      </div>`;
  }
  const panel = $(panelId);
  if (panel) panel.innerHTML = '';
}

function showResultEmpty(panelId, icon = "ph-identification-card", title = "Sin resultado", sub = "") {
  const modal = $("rmodal");
  const body  = $("rmodal-body");
  if (modal && !modal.classList.contains("hidden") && body) {
    body.innerHTML = `<div class="rmodal-empty"><i class="ph ${esc(icon)}"></i><p>${esc(title)}</p>${sub?`<small>${esc(sub)}</small>`:""}</div>`;
    return;
  }
  const panel = $(panelId);
  if (!panel) return;
  panel.innerHTML = `<div class="result-empty"><i class="ph ${esc(icon)}"></i><p>${esc(title)}</p>${sub?`<small>${esc(sub)}</small>`:""}</div>`;
}

// ── Abrir / cerrar modal de resultado ─────────────────────────
window.openResultModal = function(title, htmlContent) {
  const modal = $("rmodal");
  const body  = $("rmodal-body");
  const titleEl = $("rmodal-title");
  if (!modal) return;
  if (titleEl) titleEl.textContent = title || "RESULTADO";
  if (body) body.innerHTML = htmlContent || "";
  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
};

window.closeResultModal = function() {
  const modal = $("rmodal");
  if (!modal) return;
  modal.classList.add("hidden");
  document.body.style.overflow = "";
};

document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    closeResultModal();
    closeLightbox();
  }
});

// ── Validar DNI ────────────────────────────────────────────────
function validateDniInput(inputId) {
  const val = $(inputId)?.value.trim();
  if (!val || !/^\d{7,9}$/.test(val)) {
    showToast("Ingresa un DNI válido (8 dígitos).", "error");
    return null;
  }
  return val;
}

// ── Validar Celular ────────────────────────────────────────────
function validateCelularInput(inputId) {
  const val = $(inputId)?.value.trim();
  if (!val || !/^\d{9}$/.test(val)) {
    showToast("Ingresa un número de celular válido (9 dígitos).", "error");
    return null;
  }
  return val;
}

// ── Historial reciente ────────────────────────────────────────
function addRecentDni(dni) {
  state.recentDnis = [dni, ...state.recentDnis.filter(d => d !== dni)].slice(0, 6);
  localStorage.setItem("recentDnis", JSON.stringify(state.recentDnis));
  renderRecentChips();
}

function renderRecentChips() {
  const wrap = $("recent-chips-wrap");
  if (!wrap) return;
  if (state.recentDnis.length === 0) { wrap.innerHTML = ""; return; }
  wrap.innerHTML = state.recentDnis.map(d =>
    `<button class="chip" onclick="fillAndSearch('input-dni','${d}')">${d}</button>`
  ).join("");
}

window.fillAndSearch = function(inputId, dni) {
  const input = $(inputId);
  if (input) { input.value = dni; }
  queryDni("dni");
};

// ── Navegación SPA ────────────────────────────────────────────
const VIEW_TITLES = {
  dashboard: "Inicio",
  dni:       "Consulta por DNI",
  nm:        "Búsqueda por Nombre",
  telx:      "Titular por Celular",
  tels:      "Líneas por DNI",
  actana:    "Acta de Nacimiento",
  denuncias: "Denuncias Penales",
  facial:    "Búsqueda Facial",
};

window.navigate = function(viewId, linkEl) {
  document.querySelectorAll(".view").forEach(v => {
    v.classList.remove("active");
    v.classList.add("hidden");
  });

  const target = $("view-" + viewId);
  if (target) { target.classList.remove("hidden"); target.classList.add("active"); }

  const titleEl = $("topbar-title");
  if (titleEl) titleEl.textContent = VIEW_TITLES[viewId] || viewId;

  document.querySelectorAll(".nav-item").forEach(el => el.classList.remove("active"));
  if (linkEl) linkEl.classList.add("active");

  state.currentView = viewId;

  if (viewId === "dni") renderRecentChips();

  if (window.innerWidth < 768) closeSidebar();

  setTimeout(() => {
    const input = target?.querySelector(".query-input");
    if (input && window.innerWidth >= 768) input.focus();
  }, 150);
};

window.toggleSidebar = function() {
  const sidebar = $("sidebar");
  const overlay = $("sidebar-overlay");
  if (!sidebar) return;
  const isOpen = sidebar.classList.toggle("open");
  if (overlay) overlay.classList.toggle("active", isOpen);
  document.body.style.overflow = isOpen && window.innerWidth < 768 ? "hidden" : "";
};

window.closeSidebar = function() {
  const sidebar = $("sidebar");
  const overlay = $("sidebar-overlay");
  if (!sidebar) return;
  sidebar.classList.remove("open");
  if (overlay) overlay.classList.remove("active");
  document.body.style.overflow = "";
};

// ── Renderizar perfil DNI ─────────────────────────────────────
function renderProfile(panelId, data, raw, photoUrl) {
  const nombre = data.nombreCompleto ||
    [data.apellidos, data.nombres].filter(Boolean).join(" ") ||
    "Nombre no disponible";

  const nac = data.nacimiento || {};
  const info = data.info || {};
  const dom = data.domicilio || {};

  let mediaHtml = "";
  if (photoUrl) {
    // Usar el endpoint de preview en lugar de download para que el navegador lo muestre en lugar de descargarlo
    const previewUrl = photoUrl.replace("/api/download/", "/api/preview/");
    mediaHtml += `<div class="rmodal-media-box"><div class="rmodal-media-label">FOTO RENIEC</div><img src="${esc(previewUrl)}" alt="Foto" onclick="openLightbox(this.src)" /></div>`;
  }

  const html = `
    <div class="rmodal-content">
      <div class="rmodal-table-wrap">
        <table class="rmodal-table">
          <thead><tr><th>Campo</th><th>Valor</th></tr></thead>
          <tbody>
            <tr><td>DNI</td><td><strong>${esc(data.dni||"-")}</strong></td></tr>
            <tr><td>Nombres completos</td><td>${esc(nombre)}</td></tr>
            ${nac.fecha ? `<tr><td>Fecha de nacimiento</td><td>${esc(nac.fecha)}</td></tr>` : ""}
            ${nac.edad ? `<tr><td>Edad</td><td>${esc(nac.edad)}</td></tr>` : ""}
            ${data.genero ? `<tr><td>Sexo</td><td>${esc(data.genero)}</td></tr>` : ""}
            ${info.estadoCivil ? `<tr><td>Estado civil</td><td>${esc(info.estadoCivil)}</td></tr>` : ""}
            ${(nac.distrito||nac.provincia||nac.departamento) ? `<tr><td>Lugar de nacimiento</td><td>${esc([nac.distrito, nac.provincia, nac.departamento].filter(Boolean).join(" - "))}</td></tr>` : ""}
            ${dom.direccion ? `<tr><td>Dirección</td><td>${esc(dom.direccion)}</td></tr>` : ""}
            ${(dom.distrito||dom.provincia||dom.departamento) ? `<tr><td>Domicilio</td><td>${esc([dom.distrito, dom.provincia, dom.departamento].filter(Boolean).join(" - "))}</td></tr>` : ""}
            ${info.padre ? `<tr><td>Padre</td><td>${esc(info.padre)}</td></tr>` : ""}
            ${info.madre ? `<tr><td>Madre</td><td>${esc(info.madre)}</td></tr>` : ""}
            ${info.fechaCaducidad ? `<tr><td>Caducidad DNI</td><td>${esc(info.fechaCaducidad)}</td></tr>` : ""}
          </tbody>
        </table>
      </div>
      ${mediaHtml ? `<div class="rmodal-media-col">${mediaHtml}</div>` : ""}
    </div>
  `;
  
  openResultModal("RESULTADO RENIEC — DNI", html);
}

// ── Renderizar texto limpio del bot (Tarjetas) ────────────────
function renderTextResult(title, rawText) {
  const cleaned = cleanBotText(rawText);
  if (!cleaned) {
    openResultModal("Error", `<div class="rmodal-empty"><i class="ph ph-warning-circle"></i><p>Respuesta no válida del bot</p><small>El bot devolvió un mensaje inesperado o antispam. Intenta de nuevo.</small></div>`);
    return false;
  }
  
  const lines = cleaned.split("\n").map(l => l.trim()).filter(l => l);
  let html = `<div style="display: flex; flex-direction: column; gap: 16px; width: 100%;">`;
  let totalCards = 0;
  let rows = "";
  let hasValidKeys = false;
  let hasPersonData = false;

  // Personalizar qué campos leemos dependiendo de la consulta (para ocultar basura)
  let keyList = "Nombres?|Apellidos?|DNI|Edad|G[ée]nero|F\\. Nac\\.|Fecha|Celular|Direcci[óo]n|Operador|Plan|L[íi]nea|Estado|Documento|Descripci[óo]n";
  if (title === "LÍNEAS TELEFÓNICAS POR DNI") {
    keyList += "|Titular|Registros|Saldo|Consultor";
  } else if (title === "BÚSQUEDA POR NOMBRE") {
    keyList += "|Titular"; // Permitir Titular por si acaso, pero omitir Consultor
  }

  const regex = new RegExp(`^(${keyList})[:\\s]+(.*)`, "i");

  for (const line of lines) {
    let key = "", val = "";
    let keyMatch = line.match(regex);
    
    if (keyMatch) {
      key = keyMatch[1].trim();
      val = keyMatch[2].trim();
      
      let isPersonStart = key.toLowerCase().startsWith("nombre") || key.toLowerCase() === "titular";
      
      // Separar tarjetas SOLO si ya tenemos a una persona en la tarjeta actual y encontramos otra
      if (isPersonStart && hasPersonData) {
        totalCards++;
        html += `
          <div class="rmodal-table-wrap" style="background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden;">
            <div style="background: var(--surface2); border-bottom: 1px solid var(--border); padding: 10px 14px; font-size: 12px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px;">
              <i class="ph ph-user-circle" style="font-size: 16px; color: var(--accent);"></i> Resultado #${totalCards}
            </div>
            <table style="width: 100%; border-collapse: collapse;">
              <tbody>${rows}</tbody>
            </table>
          </div>
        `;
        rows = "";
        hasValidKeys = false;
        hasPersonData = false;
      }
      
      if (isPersonStart) {
        hasPersonData = true;
      }
    }
    
    if (key && val && val.toLowerCase() !== "n/a") {
      hasValidKeys = true;
      rows += `<tr>
        <td style="width: 35%; border-bottom: 1px solid var(--border); padding: 10px 14px; font-weight: 700; color: var(--text3); font-size: 11px; text-transform: uppercase; background: var(--surface2);">${esc(key)}</td>
        <td style="border-bottom: 1px solid var(--border); padding: 10px 14px; color: var(--text); font-size: 13px;">${esc(val)}</td>
      </tr>`;
    } else if (!keyMatch && (/^\d+\s*\|/.test(line) || line.toLowerCase().includes("detalle de l"))) {
      // SOLAMENTE atrapar las lineas de "DETALLE DE LINEAS:" y sus números (ej. 929699486 | CLARO)
      hasValidKeys = true;
      let lineContent = esc(line);
      let isTitle = line.toLowerCase().includes("detalle");
      
      rows += `<tr>
        <td colspan="2" style="border-bottom: 1px solid var(--border); padding: ${isTitle ? '14px 14px 4px' : '6px 14px'}; color: ${isTitle ? 'var(--text2)' : 'var(--text)'}; font-size: ${isTitle ? '11px' : '13px'}; font-weight: ${isTitle ? '700' : '400'}; background: ${isTitle ? 'var(--surface2)' : 'transparent'}; text-transform: ${isTitle ? 'uppercase' : 'none'};">${lineContent}</td>
      </tr>`;
    }
  }
  
  // Agregar la última tarjeta que quedó pendiente
  if (rows && hasValidKeys) {
    totalCards++;
    html += `
      <div class="rmodal-table-wrap" style="background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden;">
        <div style="background: var(--surface2); border-bottom: 1px solid var(--border); padding: 10px 14px; font-size: 12px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px;">
          <i class="ph ph-user-circle" style="font-size: 16px; color: var(--accent);"></i> Resultado #${totalCards}
        </div>
        <table style="width: 100%; border-collapse: collapse;">
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  if (totalCards === 0) {
    // Si ningun bloque tuvo formato clave/valor (por ej un texto plano importante)
    html = `<div class="rmodal-media-result"><pre class="rmodal-text-pre">${esc(cleaned)}</pre></div>`;
  } else {
    html += `</div>`;
  }
  
  openResultModal(title, html);
  return true;
}

// ── Renderizar media (imágenes / PDFs) ────────────────────────
function renderMediaResult(panelId, data) {
  if (data.text) {
    const ok = renderTextResult("RESULTADO", data.text);
    if (!ok) showResultEmpty(panelId, "ph-warning-circle", "Respuesta inválida", "El bot devolvió un mensaje inesperado.");
    return;
  }
  if (!data.mediaGroup || data.mediaGroup.length === 0) {
    showResultEmpty(panelId, "ph-warning", "Sin resultado", "El bot no devolvió archivos.");
    return;
  }

  let html = `<div class="rmodal-media-result"><div class="rmodal-media-grid">`;
  let hasValidMedia = false;

  data.mediaGroup.forEach((item, i) => {
    const isPdf = item.fileType === "pdf" || /\.pdf$/i.test(item.fileName || "");
    if (!isPdf) return; // Ignorar imágenes (como el thumbnail del bot)

    hasValidMedia = true;
    const name = esc(item.fileName || `documento_${i+1}.pdf`);
    html += `<div class="rmodal-pdf-wrap"><iframe class="rmodal-pdf-frame" src="/api/preview/${item.messageId}" title="${name}"></iframe></div>`;
    html += `<a class="rmodal-download-btn" href="${esc(item.downloadUrl)}" download="${name}" target="_blank"><i class="ph ph-download-simple"></i> Descargar ${name}</a>`;
  });
  html += `</div></div>`;
  
  if (!hasValidMedia) {
    showResultEmpty(panelId, "ph-warning", "Sin resultado", "No se encontraron documentos PDF.");
    return;
  }
  
  openResultModal("DOCUMENTO RESULTANTE", html);
}

// ── Fetch con timeout 20s y manejo de error ───────────────────
async function fetchWithTimeout(url, options, timeoutMs = 22000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new Error("Tiempo de espera agotado (20s). El bot no respondió a tiempo.");
    }
    throw err;
  }
}

// ── Query: DNI completo (/dni) ────────────────────────────────
window.queryDni = async function(cmd) {
  const inputId = "input-" + cmd;
  const resultId = "result-" + cmd;
  const btnId = "btn-" + cmd;

  const dni = validateDniInput(inputId);
  if (!dni) return;

  showResultLoading(resultId, "Consultando RENIEC con /dni...");
  if (btnId) setLoading(btnId, true);

  try {
    const res = await fetchWithTimeout("/api/query/" + cmd, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dni }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      const msg = data.error || "Error al consultar";
      showResultEmpty(resultId, "ph-warning-circle", msg);
      showToast(msg, "error");
      return;
    }

    // Verificar si la respuesta cruda es basura
    if (data.raw && isJunkResponse(data.raw) && !data.data?.nombres) {
      showResultEmpty(resultId, "ph-warning-circle", "Respuesta no válida", "El bot devolvió un mensaje inesperado. Intenta de nuevo.");
      showToast("Respuesta inválida del bot.", "error");
      return;
    }

    if (cmd === "dni") addRecentDni(dni);
    renderProfile(resultId, data.data, data.raw, data.photoUrl);
    showToast("Datos obtenidos correctamente.", "success");
  } catch (err) {
    const msg = err.message.includes("agotado") ? err.message : "Error de conexión: " + err.message;
    showResultEmpty(resultId, "ph-warning-octagon", "Error", msg);
    showToast(msg, "error");
  } finally {
    if (btnId) setLoading(btnId, false);
  }
};

// ── Query: Búsqueda por Nombre (/nm) ─────────────────────────
window.queryNombre = async function() {
  const nombres = $("input-nm-nombres")?.value.trim();
  const pat     = $("input-nm-pat")?.value.trim();
  const mat     = $("input-nm-mat")?.value.trim();

  if (!nombres || !pat) {
    showToast("Nombre y apellido paterno son requeridos.", "error");
    return;
  }

  showResultLoading("result-nm", "Buscando por nombre con /nm...");
  setLoading("btn-nm", true);

  try {
    const res = await fetchWithTimeout("/api/query/nm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nombres, apellidoPat: pat, apellidoMat: mat }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      const msg = data.error || "Error al buscar";
      showResultEmpty("result-nm", "ph-warning-circle", msg);
      showToast(msg, "error");
      return;
    }
    const text = data.text || data.raw || "";
    if (!text || isJunkResponse(text)) {
      showResultEmpty("result-nm", "ph-warning-circle", "Sin resultados válidos", "El bot no devolvió datos de persona. Verifica el nombre.");
      showToast("Sin resultados válidos del bot.", "error");
      return;
    }
    renderTextResult("BÚSQUEDA POR NOMBRE", text);
    showToast("Búsqueda completada.", "success");
  } catch (err) {
    const msg = err.message.includes("agotado") ? err.message : "Error de conexión: " + err.message;
    showResultEmpty("result-nm", "ph-warning-octagon", "Error", msg);
    showToast(msg, "error");
  } finally {
    setLoading("btn-nm", false);
  }
};

// ── Query: Titular por Celular (/telx) ────────────────────────
window.queryTelx = async function() {
  const cel = validateCelularInput("input-telx");
  if (!cel) return;

  showResultLoading("result-telx", "Consultando titular con /telx...");
  setLoading("btn-telx", true);

  try {
    const res = await fetchWithTimeout("/api/query/telx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dni: cel }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      const msg = data.error || "Error al consultar";
      showResultEmpty("result-telx", "ph-warning-circle", msg);
      showToast(msg, "error");
      return;
    }
    const text = data.text || "";
    if (!text || isJunkResponse(text)) {
      showResultEmpty("result-telx", "ph-warning-circle", "Sin resultados válidos", "El bot no encontró titular para ese número.");
      showToast("Sin resultados válidos.", "error");
      return;
    }
    renderTextResult("TITULAR POR CELULAR", text);
    showToast("Titular encontrado.", "success");
  } catch (err) {
    const msg = err.message.includes("agotado") ? err.message : "Error de conexión: " + err.message;
    showResultEmpty("result-telx", "ph-warning-octagon", "Error", msg);
    showToast(msg, "error");
  } finally {
    setLoading("btn-telx", false);
  }
};

// ── Query: Líneas por DNI (/tels) ─────────────────────────────
window.queryTels = async function() {
  const dni = validateDniInput("input-tels");
  if (!dni) return;

  showResultLoading("result-tels", "Consultando líneas con /tels...");
  setLoading("btn-tels", true);

  try {
    const res = await fetchWithTimeout("/api/query/tels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dni }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      const msg = data.error || "Error al consultar";
      showResultEmpty("result-tels", "ph-warning-circle", msg);
      showToast(msg, "error");
      return;
    }
    const text = data.text || "";
    if (!text || isJunkResponse(text)) {
      showResultEmpty("result-tels", "ph-warning-circle", "Sin líneas encontradas", "No hay líneas registradas para ese DNI.");
      showToast("Sin líneas registradas.", "error");
      return;
    }
    renderTextResult("LÍNEAS TELEFÓNICAS POR DNI", text);
    showToast("Líneas obtenidas.", "success");
  } catch (err) {
    const msg = err.message.includes("agotado") ? err.message : "Error de conexión: " + err.message;
    showResultEmpty("result-tels", "ph-warning-octagon", "Error", msg);
    showToast(msg, "error");
  } finally {
    setLoading("btn-tels", false);
  }
};

// ── Query: Acta de Nacimiento (/actana) ───────────────────────
window.queryActana = async function() {
  const dni = validateDniInput("input-actana");
  if (!dni) return;

  showResultLoading("result-actana", "Obteniendo acta de nacimiento con /actana...");
  setLoading("btn-actana", true);

  try {
    const res = await fetchWithTimeout("/api/query/actana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dni }),
    }, 35000);
    const data = await res.json();
    if (!res.ok || !data.ok) {
      const msg = data.error || "Error al obtener acta";
      showResultEmpty("result-actana", "ph-warning-circle", msg);
      showToast(msg, "error");
      return;
    }
    if (data.text && isJunkResponse(data.text)) {
      showResultEmpty("result-actana", "ph-warning-circle", "Sin resultados válidos", "El bot no devolvió el acta. Verifica el DNI.");
      showToast("Sin resultados válidos del bot.", "error");
      return;
    }
    renderMediaResult("result-actana", data);
    showToast("Acta de nacimiento obtenida.", "success");
  } catch (err) {
    const msg = err.message.includes("agotado") ? err.message : "Error de conexión: " + err.message;
    showResultEmpty("result-actana", "ph-warning-octagon", "Error", msg);
    showToast(msg, "error");
  } finally {
    setLoading("btn-actana", false);
  }
};

// ── Query: Denuncias Penales (/denuncias) ─────────────────────
window.queryDenuncias = async function() {
  const dni = validateDniInput("input-denuncias");
  if (!dni) return;

  showResultLoading("result-denuncias", "Consultando denuncias con /denuncias...");
  setLoading("btn-denuncias", true);

  try {
    const res = await fetchWithTimeout("/api/query/denuncias", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dni }),
    }, 35000);
    const data = await res.json();
    if (!res.ok || !data.ok) {
      const msg = data.error || "Error al consultar denuncias";
      showResultEmpty("result-denuncias", "ph-warning-circle", msg);
      showToast(msg, "error");
      return;
    }
    if (data.text && isJunkResponse(data.text)) {
      showResultEmpty("result-denuncias", "ph-warning-circle", "Sin resultados válidos", "El bot no devolvió denuncias. Verifica el DNI.");
      showToast("Sin resultados válidos del bot.", "error");
      return;
    }
    renderMediaResult("result-denuncias", data);
    showToast("Denuncias obtenidas.", "success");
  } catch (err) {
    const msg = err.message.includes("agotado") ? err.message : "Error de conexión: " + err.message;
    showResultEmpty("result-denuncias", "ph-warning-octagon", "Error", msg);
    showToast(msg, "error");
  } finally {
    setLoading("btn-denuncias", false);
  }
};

// ── Búsqueda Facial (/facial + foto) ─────────────────────────
let facialFile = null;

window.onFacialFileChange = function(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    showToast("Solo se permiten imágenes (JPG, PNG).", "error");
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    showToast("La imagen supera los 15 MB.", "error");
    return;
  }
  facialFile = file;

  // Mostrar preview
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = $("facial-preview-img");
    const placeholder = $("facial-placeholder");
    if (img) { img.src = e.target.result; img.classList.remove("hidden"); }
    if (placeholder) placeholder.classList.add("hidden");
  };
  reader.readAsDataURL(file);

  // Habilitar botón
  const btn = $("btn-facial");
  if (btn) btn.disabled = false;
};

window.queryFacial = async function() {
  if (!facialFile) {
    showToast("Selecciona una foto primero.", "error");
    return;
  }

  showResultLoading("result-facial", "Analizando rostro con /facial...");
  setLoading("btn-facial", true);

  try {
    const formData = new FormData();
    formData.append("photo", facialFile);

    const res = await fetchWithTimeout("/api/query/facial", {
      method: "POST",
      body: formData,
    }, 65000);
    const data = await res.json();
    if (!res.ok || !data.ok) {
      const msg = data.error || "Error en búsqueda facial";
      showResultEmpty("result-facial", "ph-warning-circle", msg);
      showToast(msg, "error");
      return;
    }
    renderFacialResult(data);
    showToast("Reporte facial obtenido.", "success");
  } catch (err) {
    const msg = err.message.includes("agotado") ? err.message : "Error de conexión: " + err.message;
    showResultEmpty("result-facial", "ph-warning-octagon", "Error", msg);
    showToast(msg, "error");
  } finally {
    setLoading("btn-facial", false);
  }
};

// ── Renderizar resultado facial (PDF en modal) ────────────────
function renderFacialResult(data) {
  if (!data.mediaGroup || data.mediaGroup.length === 0) {
    showResultEmpty("result-facial", "ph-warning", "Sin resultado", "El bot no devolvió un PDF.");
    return;
  }

  const pdfs = data.mediaGroup.filter(item =>
    item.fileType === "pdf" || /\.pdf$/i.test(item.fileName || "")
  );

  if (pdfs.length === 0) {
    showResultEmpty("result-facial", "ph-warning", "Sin PDF", "El bot respondió pero no con un PDF biométrico.");
    return;
  }

  let html = `<div class="facial-result-modal">`;

  pdfs.forEach((item, i) => {
    const name = esc(item.fileName || `reporte_facial_${i+1}.pdf`);
    html += `
      <div class="facial-pdf-hero">
        <div class="facial-pdf-icon-wrap">
          <i class="ph ph-file-pdf"></i>
        </div>
        <div class="facial-pdf-info">
          <div class="facial-pdf-name">${name}</div>
          <div class="facial-pdf-sub">Reporte Biométrico Facial</div>
        </div>
      </div>
      <div class="facial-pdf-frame-wrap">
        <iframe class="facial-pdf-frame" src="/api/preview/${item.messageId}" title="${name}"></iframe>
      </div>
      <a class="facial-pdf-download-btn" href="${esc(item.downloadUrl)}" download="${name}" target="_blank">
        <i class="ph ph-download-simple"></i> Descargar Reporte PDF
      </a>
    `;
  });

  html += `</div>`;
  openResultModal("📋 REPORTE BIOMÉTRICO FACIAL", html);
}

// ── Lightbox ──────────────────────────────────────────────────
window.openLightbox = function(src) {
  const img = $("lightbox-img");
  const lb  = $("lightbox");
  if (img) img.src = src;
  if (lb)  lb.classList.remove("hidden");
};

function closeLightbox() {
  const lb  = $("lightbox");
  const img = $("lightbox-img");
  if (lb)  lb.classList.add("hidden");
  if (img) img.src = "";
}

document.addEventListener("DOMContentLoaded", () => {
  const lb = $("lightbox");
  const lbClose = $("lightbox-close");
  if (lb) lb.addEventListener("click", e => { if (e.target === lb) closeLightbox(); });
  if (lbClose) lbClose.addEventListener("click", closeLightbox);
});

// ── Input: solo dígitos en campos DNI y Celular ─────────────────
document.querySelectorAll(".query-input[maxlength='8'], .query-input[maxlength='9']").forEach(inp => {
  inp.addEventListener("input", () => {
    const max = parseInt(inp.getAttribute("maxlength") || "8", 10);
    inp.value = inp.value.replace(/\D/g, "").slice(0, max);
  });
  inp.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      const btn = inp.closest(".query-form-panel")?.querySelector(".query-btn");
      if (btn && !btn.disabled) btn.click();
    }
  });
});

// ── Buscador en sidebar ───────────────────────────────────────
window.filterSidebarNav = function(val) {
  const q = val.toLowerCase();
  document.querySelectorAll(".nav-item").forEach(el => {
    const text = el.textContent.toLowerCase();
    el.style.display = !val || text.includes(q) ? "" : "none";
  });
};

// ── Estado de conexión ────────────────────────────────────────
function setStatus(status) {
  const cls = status==="ready"?"online":status==="error"?"error":"";
  ["status-dot","topbar-dot"].forEach(id => {
    const el = $(id);
    if (el) el.className = "status-dot" + (cls?" "+cls:"");
  });
  const labels = { ready:"En línea", connecting:"Conectando...", error:"Sin conexión", reconnecting:"Reconectando..." };
  const label = labels[status] || status;
  ["status-text","topbar-status-text"].forEach(id => {
    const el = $(id);
    if (el) el.textContent = label;
  });
}

// ── Socket.IO ─────────────────────────────────────────────────
function initSocket() {
  try {
    const socket = io({ transports: ["polling","websocket"], reconnectionDelay: 2000 });
    state.socket = socket;
    socket.on("connect", () => console.log("[Socket] Conectado"));
    socket.on("status", data => {
      if (data.status === "ready") setStatus("ready");
      else if (data.status === "error") setStatus("error");
      else setStatus(data.status);
    });
    socket.on("disconnect", () => { setStatus("error"); showToast("Conexión perdida. Reconectando...", "error"); });
    socket.on("reconnect", () => { setStatus("ready"); showToast("Conexión restaurada.", "success"); });
  } catch(e) {
    console.warn("[Socket] Socket.IO no disponible:", e.message);
  }
}

// ── Estado inicial via HTTP ────────────────────────────────────
async function checkInitialStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    setStatus(data.status || "connecting");
  } catch (e) {
    setStatus("error");
  }
}

// ── Init ────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async function() {
  initSocket();
  await checkInitialStatus();
  renderRecentChips();

  // Highlight active nav based on current view
  const activeNav = document.querySelector(`.nav-item[data-view="dashboard"]`);
  if (activeNav) activeNav.classList.add("active");

  // Click en zona de preview facial abre selector
  const facialWrap = $("facial-preview-wrap");
  if (facialWrap) {
    facialWrap.addEventListener("click", () => {
      const input = $("facial-photo-input");
      if (input) input.click();
    });
  }

  setTimeout(() => {
    const input = document.querySelector("#view-dashboard .query-input");
    if (input) input.focus();
  }, 600);
});
