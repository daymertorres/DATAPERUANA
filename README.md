# ONIXDATA — Sistema de Consulta Ciudadana

Sistema web de consulta de datos RENIEC, telefonía y denuncias usando el bot **@onixdataa_bot** via Telegram MTProto.

## Comandos disponibles

| Módulo | Comando | Parámetro | Resultado |
|--------|---------|-----------|-----------|
| Consulta DNI | `/dni` | `12345678` | Datos completos + foto |
| Búsqueda por Nombre | `/nm` | `JUAN|PEREZ|GARCIA` | Datos de la persona |
| Titular por Celular | `/telx` | `999999999` | Datos del titular |
| Líneas por DNI | `/tels` | `12345678` | Líneas asociadas |
| Acta de Nacimiento | `/actana` | `12345678` | PDF del acta |
| Denuncias Penales | `/denuncias` | `12345678` | PDF lista denuncias |

## Configuración

Crea un archivo `.env` en la raíz del proyecto:

```
API_ID=TU_API_ID
API_HASH=TU_API_HASH
PHONE_NUMBER=+51XXXXXXXXX
TARGET_GROUP=@tu_grupo_telegram
BOT_USERNAME=@onixdataa_bot
SESSION_STRING=   (opcional, para Vercel)
```

## Instalación

```bash
npm install
npm start
```

## Características

- **Sin login** — Acceso directo al sistema
- **Bot: @onixdataa_bot** — Comandos enviados en privado al bot
- **Animación de carga** — Orbe animado mientras se consulta
- **Timeout 20s** — Mensaje de error si el bot no responde
- **Filtro antispam** — Se descartan respuestas inválidas del bot
- **Preview PDF** — Los PDFs se visualizan en iframe integrado
- **Dark mode premium** — Diseño oscuro profesional
