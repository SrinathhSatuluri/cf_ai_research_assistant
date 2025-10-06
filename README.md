# CF AI Research Assistant

An AI-powered research assistant built on Cloudflare Workers platform, featuring real-time chat interface with persistent conversation history.

## Architecture

**LLM**: Llama 3.1 8B Instruct via Cloudflare Workers AI
**Workflow/Coordination**: Durable Objects for session management and state persistence
**User Interface**: Real-time chat with sidebar navigation
**Memory/State**: Persistent conversation history across sessions

## Features

- Real-time AI chat interface
- Session management with conversation history
- Automatic chat titling based on first message
- Chat deletion and navigation
- Responsive design with glassmorphism UI
- Keyboard shortcuts (Ctrl+K for new chat)

## Live Demo

**🌐 [Try the AI Research Assistant](https://cf-ai-research-assistant.satulurisrinath.workers.dev)**

## Local Development

### Prerequisites
- Node.js 18+
- Cloudflare account with Workers AI access

### Setup
```bash
git clone <repository-url>
cd cf_ai_research_assistant
npm install
```

### Configuration
Update `wrangler.jsonc` with your account details if needed. The current configuration uses:
- AI binding for Llama 3.1 model
- Durable Objects for session storage
- Local development port 8788

### Run Locally
```bash
npm run dev
```
Access at: http://localhost:8788

### Deploy
```bash
npm run deploy
```

## API Endpoints

- `POST /api/session` - Create new chat session
- `GET /api/sessions` - Get all sessions
- `GET /api/session/{id}` - Get specific session
- `POST /api/chat/{sessionId}` - Send message to session
- `DELETE /api/session/{id}/delete` - Delete session
- `PUT /api/session/{id}/title` - Update session title

## Project Structure

```
src/
├── index.ts          # Main Worker with Durable Object implementation
wrangler.jsonc        # Cloudflare configuration
package.json          # Dependencies
```

## Technical Implementation

### Durable Objects
Handles session persistence, message storage, and conversation state management. Each session maintains its own isolated state with automatic cleanup.

### Workers AI Integration
Direct integration with Cloudflare's AI service using Llama 3.1 model for research-focused responses with conversation context.

### Frontend
Single-page application with modern chat interface, built-in HTML/CSS/JS with no external frameworks for optimal performance.

## Requirements Satisfied

- **LLM**: Llama 3.1 8B Instruct via Workers AI
- **Workflow/Coordination**: Durable Objects managing sessions and state
- **User Input**: Full-featured chat interface
- **Memory/State**: Persistent conversation history and session management