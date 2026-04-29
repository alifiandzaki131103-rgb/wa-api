# WA API - WhatsApp Gateway

Multi-session WhatsApp Gateway with web dashboard, built with **whatsapp-web.js** + **Express**.

## Features
- 📱 Multi-session WhatsApp support
- 🔐 Login with username/password
- 📊 Web dashboard with QR code display
- 🔑 API key management + regenerate
- 📤 Send messages via REST API
- 🔄 Auto-reconnect on disconnect
- 💾 Persistent sessions (survives restart)

## Quick Start
```bash
npm install
node index.js
```

## Environment Variables
| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 2785 | Server port |
| ADMIN_USER | admin | Dashboard login username |
| ADMIN_PASS | - | Dashboard login password |

## API Endpoints
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Health check + session statuses |
| GET | /api/sessions | List all sessions |
| POST | /api/sessions | Create session: `{"id": "my-session"}` |
| GET | /api/sessions/:id | Session status |
| GET | /api/sessions/:id/qr | Get QR code (base64) |
| DELETE | /api/sessions/:id?logout=true | Delete session |
| POST | /api/send/text | Send message: `{"to":"628xxx","text":"Hi","sessionId":"my-session"}` |

### Authentication
All `/api/*` endpoints require header: `X-API-Key: YOUR_KEY`

## License
MIT
