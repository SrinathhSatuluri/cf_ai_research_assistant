import { DurableObject } from "cloudflare:workers";

interface ChatMessage {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	timestamp: number;
}

interface ResearchSession {
	id: string;
	title: string;
	messages: ChatMessage[];
	createdAt: number;
	updatedAt: number;
}

export class MyDurableObject extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async createSession(title: string): Promise<ResearchSession> {
		const sessionId = crypto.randomUUID();
		const session: ResearchSession = {
			id: sessionId,
			title,
			messages: [],
			createdAt: Date.now(),
			updatedAt: Date.now()
		};

		await this.ctx.storage.put(`session:${sessionId}`, session);

		// Add to sessions list
		const sessionsList = await this.ctx.storage.get<string[]>('sessions_list') || [];
		sessionsList.unshift(sessionId); // Add to beginning
		await this.ctx.storage.put('sessions_list', sessionsList);

		return session;
	}

	async getAllSessions(): Promise<ResearchSession[]> {
		const sessionsList = await this.ctx.storage.get<string[]>('sessions_list') || [];
		const sessions: ResearchSession[] = [];

		for (const sessionId of sessionsList) {
			const session = await this.ctx.storage.get<ResearchSession>(`session:${sessionId}`);
			if (session) {
				sessions.push(session);
			}
		}

		return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async deleteSession(sessionId: string): Promise<boolean> {
		await this.ctx.storage.delete(`session:${sessionId}`);

		const sessionsList = await this.ctx.storage.get<string[]>('sessions_list') || [];
		const updatedList = sessionsList.filter(id => id !== sessionId);
		await this.ctx.storage.put('sessions_list', updatedList);

		return true;
	}

	async updateSessionTitle(sessionId: string, title: string): Promise<boolean> {
		const session = await this.getSession(sessionId);
		if (!session) return false;

		session.title = title;
		session.updatedAt = Date.now();
		await this.ctx.storage.put(`session:${sessionId}`, session);
		return true;
	}

	async getSession(sessionId: string): Promise<ResearchSession | null> {
		const session = await this.ctx.storage.get<ResearchSession>(`session:${sessionId}`);
		return session || null;
	}

	async addMessage(sessionId: string, role: 'user' | 'assistant', content: string): Promise<ChatMessage> {
		const session = await this.getSession(sessionId);
		if (!session) {
			throw new Error('Session not found');
		}

		const message: ChatMessage = {
			id: crypto.randomUUID(),
			role,
			content,
			timestamp: Date.now()
		};

		session.messages.push(message);
		session.updatedAt = Date.now();

		await this.ctx.storage.put(`session:${sessionId}`, session);
		return message;
	}

	async getChatHistory(sessionId: string): Promise<ChatMessage[]> {
		const session = await this.getSession(sessionId);
		return session?.messages || [];
	}

	async generateResponse(sessionId: string, userMessage: string): Promise<string> {
		await this.addMessage(sessionId, 'user', userMessage);

		// Get conversation history for context
		const history = await this.getChatHistory(sessionId);
		const recentMessages = history.slice(-6).map(msg => ({
			role: msg.role,
			content: msg.content
		}));

		// Call real AI - no fallbacks, pure LLM only
		const response = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct' as any, {
			messages: [
				{
					role: 'system',
					content: 'You are an AI research assistant. Help users with research tasks, provide detailed analysis, and break down complex topics. Be thorough and cite sources when possible.'
				},
				...recentMessages
			],
			max_tokens: 1024,
			temperature: 0.7
		}) as any;

		const assistantMessage = response.response || 'I apologize, but I received an empty response. Please try asking your question again.';

		await this.addMessage(sessionId, 'assistant', assistantMessage);
		return assistantMessage;
	}

}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// CORS headers
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
		};

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		try {
			if (path === '/') {
				return new Response(getChatHTML(), {
					headers: { ...corsHeaders, 'Content-Type': 'text/html' }
				});
			}

			if (path === '/api/session' && request.method === 'POST') {
				const { title } = await request.json() as { title: string };
				const stub = env.MY_DURABLE_OBJECT.getByName("research-session");
				const session = await stub.createSession(title || 'New Research Session');

				return new Response(JSON.stringify(session), {
					headers: { ...corsHeaders, 'Content-Type': 'application/json' }
				});
			}

			if (path.startsWith('/api/chat/') && request.method === 'POST') {
				const sessionId = path.split('/')[3];
				const { message } = await request.json() as { message: string };

				const stub = env.MY_DURABLE_OBJECT.getByName("research-session");
				const response = await stub.generateResponse(sessionId, message);

				return new Response(JSON.stringify({ response }), {
					headers: { ...corsHeaders, 'Content-Type': 'application/json' }
				});
			}

			if (path.startsWith('/api/session/') && request.method === 'GET') {
				const sessionId = path.split('/')[3];
				const stub = env.MY_DURABLE_OBJECT.getByName("research-session");
				const session = await stub.getSession(sessionId);

				if (!session) {
					return new Response('Session not found', {
						status: 404,
						headers: corsHeaders
					});
				}

				return new Response(JSON.stringify(session), {
					headers: { ...corsHeaders, 'Content-Type': 'application/json' }
				});
			}

			if (path === '/api/sessions' && request.method === 'GET') {
				const stub = env.MY_DURABLE_OBJECT.getByName("research-session");
				const sessions = await stub.getAllSessions();

				return new Response(JSON.stringify(sessions), {
					headers: { ...corsHeaders, 'Content-Type': 'application/json' }
				});
			}

			if (path.startsWith('/api/session/') && path.endsWith('/delete') && request.method === 'DELETE') {
				const sessionId = path.split('/')[3];
				const stub = env.MY_DURABLE_OBJECT.getByName("research-session");
				await stub.deleteSession(sessionId);

				return new Response(JSON.stringify({ success: true }), {
					headers: { ...corsHeaders, 'Content-Type': 'application/json' }
				});
			}

			if (path.startsWith('/api/session/') && path.endsWith('/title') && request.method === 'PUT') {
				const sessionId = path.split('/')[3];
				const { title } = await request.json() as { title: string };
				const stub = env.MY_DURABLE_OBJECT.getByName("research-session");
				await stub.updateSessionTitle(sessionId, title);

				return new Response(JSON.stringify({ success: true }), {
					headers: { ...corsHeaders, 'Content-Type': 'application/json' }
				});
			}

			return new Response('Not found', {
				status: 404,
				headers: corsHeaders
			});

		} catch (error) {
			console.error('Error:', error);
			return new Response('Internal server error', {
				status: 500,
				headers: corsHeaders
			});
		}
	},
} satisfies ExportedHandler<Env>;

function getChatHTML(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Research Assistant</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            background-attachment: fixed;
            height: 100vh;
            display: flex;
            overflow: hidden;
            margin: 0;
        }

        .sidebar {
            width: 320px;
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(20px);
            border-right: 1px solid rgba(255, 255, 255, 0.2);
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .sidebar-header {
            padding: 1.5rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.2);
        }

        .sidebar-header h1 {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            font-size: 1.5rem;
            font-weight: 700;
            margin-bottom: 0.5rem;
        }

        .new-chat-btn {
            width: 100%;
            padding: 0.875rem 1rem;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 12px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            margin-top: 1rem;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
        }

        .new-chat-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(102, 126, 234, 0.4);
        }

        .chat-history {
            flex: 1;
            overflow-y: auto;
            padding: 1rem;
        }

        .chat-history::-webkit-scrollbar {
            width: 4px;
        }

        .chat-history::-webkit-scrollbar-track {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 10px;
        }

        .chat-history::-webkit-scrollbar-thumb {
            background: rgba(102, 126, 234, 0.3);
            border-radius: 10px;
        }

        .chat-item {
            padding: 0.75rem;
            margin-bottom: 0.5rem;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.3s ease;
            background: rgba(255, 255, 255, 0.5);
            border: 1px solid rgba(255, 255, 255, 0.3);
            position: relative;
            group: hover;
        }

        .chat-item:hover {
            background: rgba(255, 255, 255, 0.8);
            transform: translateX(4px);
        }

        .chat-item.active {
            background: rgba(102, 126, 234, 0.2);
            border-color: rgba(102, 126, 234, 0.4);
        }

        .chat-item-title {
            font-weight: 500;
            color: #1e293b;
            margin-bottom: 0.25rem;
            font-size: 0.9rem;
            line-height: 1.3;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .chat-item-time {
            font-size: 0.75rem;
            color: #64748b;
        }

        .chat-item-actions {
            position: absolute;
            right: 0.5rem;
            top: 50%;
            transform: translateY(-50%);
            opacity: 0;
            transition: opacity 0.3s ease;
        }

        .chat-item:hover .chat-item-actions {
            opacity: 1;
        }

        .delete-btn {
            background: none;
            border: none;
            color: #ef4444;
            cursor: pointer;
            padding: 0.25rem;
            border-radius: 4px;
            transition: all 0.3s ease;
        }

        .delete-btn:hover {
            background: rgba(239, 68, 68, 0.1);
        }

        .main-content {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .main-header {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(20px);
            padding: 1rem 2rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.2);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }

        .main-header h2 {
            color: #1e293b;
            font-size: 1.25rem;
            font-weight: 600;
        }

        .main-header p {
            color: #64748b;
            font-size: 0.9rem;
            margin-top: 0.25rem;
        }

        .chat-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            max-width: 1000px;
            margin: 0 auto;
            width: 100%;
            padding: 0 1.5rem;
            height: 100%;
        }

        .messages {
            flex: 1;
            overflow-y: auto;
            padding: 2rem 0;
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            scroll-behavior: smooth;
        }

        .messages::-webkit-scrollbar {
            width: 6px;
        }

        .messages::-webkit-scrollbar-track {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 10px;
        }

        .messages::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.3);
            border-radius: 10px;
        }

        .message {
            max-width: 80%;
            padding: 1.5rem;
            border-radius: 20px;
            line-height: 1.6;
            font-size: 0.95rem;
            animation: slideIn 0.4s ease-out;
            position: relative;
        }

        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateY(20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .message.user {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            align-self: flex-end;
            margin-left: auto;
            box-shadow: 0 8px 32px rgba(102, 126, 234, 0.3);
            border-bottom-right-radius: 8px;
        }

        .message.assistant {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(20px);
            color: #1e293b;
            align-self: flex-start;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-bottom-left-radius: 8px;
        }

        .input-container {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(20px);
            padding: 1.5rem;
            border-top: 1px solid rgba(255, 255, 255, 0.2);
            display: flex;
            gap: 1rem;
            align-items: center;
            box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.1);
        }

        .input-container input {
            flex: 1;
            padding: 1rem 1.5rem;
            border: 2px solid rgba(102, 126, 234, 0.2);
            border-radius: 25px;
            font-size: 0.95rem;
            font-family: inherit;
            background: rgba(255, 255, 255, 0.8);
            transition: all 0.3s ease;
            outline: none;
        }

        .input-container input:focus {
            border-color: #667eea;
            box-shadow: 0 0 0 4px rgba(102, 126, 234, 0.1);
            background: rgba(255, 255, 255, 0.95);
        }

        .input-container input::placeholder {
            color: #94a3b8;
        }

        .input-container button {
            padding: 1rem 2rem;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 25px;
            cursor: pointer;
            font-size: 0.95rem;
            font-weight: 600;
            font-family: inherit;
            transition: all 0.3s ease;
            box-shadow: 0 4px 16px rgba(102, 126, 234, 0.3);
        }

        .input-container button:hover:not(:disabled) {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(102, 126, 234, 0.4);
        }

        .input-container button:active {
            transform: translateY(0);
        }

        .input-container button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
            box-shadow: 0 4px 16px rgba(102, 126, 234, 0.2);
        }

        .loading {
            color: #64748b;
            font-style: italic;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .loading::after {
            content: '';
            width: 16px;
            height: 16px;
            border: 2px solid #e2e8f0;
            border-top: 2px solid #667eea;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .typing-indicator {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            color: #64748b;
            font-style: italic;
            padding: 1rem 1.5rem;
        }

        .typing-dots {
            display: flex;
            gap: 0.25rem;
        }

        .typing-dots span {
            width: 6px;
            height: 6px;
            background: #667eea;
            border-radius: 50%;
            animation: typing 1.4s infinite ease-in-out;
        }

        .typing-dots span:nth-child(1) { animation-delay: -0.32s; }
        .typing-dots span:nth-child(2) { animation-delay: -0.16s; }

        @keyframes typing {
            0%, 80%, 100% { transform: scale(0.8); opacity: 0.5; }
            40% { transform: scale(1.2); opacity: 1; }
        }

        /* Mobile responsiveness */
        @media (max-width: 768px) {
            .header {
                padding: 1rem 1.5rem;
            }

            .header h1 {
                font-size: 1.5rem;
            }

            .chat-container {
                padding: 0 1rem;
            }

            .message {
                max-width: 90%;
                padding: 1rem;
                font-size: 0.9rem;
            }

            .input-container {
                padding: 1rem;
            }

            .input-container input {
                padding: 0.875rem 1.25rem;
                font-size: 0.9rem;
            }

            .input-container button {
                padding: 0.875rem 1.5rem;
                font-size: 0.9rem;
            }
        }
    </style>
</head>
<body>
    <div class="sidebar" id="sidebar">
        <div class="sidebar-header">
            <h1>🔬 AI Research</h1>
            <button class="new-chat-btn" onclick="createNewChat()">
                <span>✨ New Chat</span>
            </button>
        </div>
        <div class="chat-history" id="chatHistory">
            <!-- Chat history items will be populated here -->
        </div>
    </div>

    <div class="main-content">
        <div class="main-header">
            <h2 id="currentChatTitle">New Research Session</h2>
            <p>Powered by Llama 3.1 on Cloudflare Workers AI</p>
        </div>

        <div class="chat-container">
            <div class="messages" id="messages"></div>

            <div class="input-container">
                <input
                    type="text"
                    id="messageInput"
                    placeholder="Ask me anything about your research..."
                    onkeypress="if(event.key==='Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); }"
                    maxlength="1000"
                >
                <button onclick="sendMessage()" id="sendButton">
                    <span id="sendText">Send</span>
                </button>
            </div>
        </div>
    </div>

    <script>
        let currentSessionId = null;
        let isTyping = false;
        let allSessions = [];

        async function loadChatHistory() {
            try {
                const response = await fetch('/api/sessions');
                allSessions = await response.json();
                renderChatHistory();
            } catch (error) {
                console.error('Failed to load chat history:', error);
            }
        }

        function renderChatHistory() {
            const chatHistory = document.getElementById('chatHistory');
            chatHistory.innerHTML = '';

            if (allSessions.length === 0) {
                chatHistory.innerHTML = '<div style="padding: 1rem; text-align: center; color: #64748b; font-size: 0.9rem;">No conversations yet</div>';
                return;
            }

            allSessions.forEach(session => {
                const chatItem = document.createElement('div');
                chatItem.className = \`chat-item \${session.id === currentSessionId ? 'active' : ''}\`;
                chatItem.onclick = () => loadSession(session.id);

                const timeAgo = formatTimeAgo(session.updatedAt);
                const preview = session.messages.length > 0 ?
                    session.messages[session.messages.length - 1].content.substring(0, 60) + '...' :
                    'New conversation';

                chatItem.innerHTML = \`
                    <div class="chat-item-title">\${session.title}</div>
                    <div class="chat-item-time">\${timeAgo}</div>
                    <div class="chat-item-actions">
                        <button class="delete-btn" onclick="event.stopPropagation(); deleteSession('\${session.id}')">🗑️</button>
                    </div>
                \`;

                chatHistory.appendChild(chatItem);
            });
        }

        function formatTimeAgo(timestamp) {
            const now = Date.now();
            const diff = now - timestamp;
            const minutes = Math.floor(diff / 60000);
            const hours = Math.floor(diff / 3600000);
            const days = Math.floor(diff / 86400000);

            if (days > 0) return \`\${days}d ago\`;
            if (hours > 0) return \`\${hours}h ago\`;
            if (minutes > 0) return \`\${minutes}m ago\`;
            return 'Just now';
        }

        async function createNewChat() {
            try {
                const response = await fetch('/api/session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: 'New Research Session' })
                });
                const session = await response.json();
                currentSessionId = session.id;

                // Clear current chat
                document.getElementById('messages').innerHTML = '';
                document.getElementById('currentChatTitle').textContent = session.title;

                // Reload history and show welcome
                await loadChatHistory();

                setTimeout(() => {
                    addMessage('assistant', 'Hello! I\\'m your AI research assistant powered by Llama 3.1. I can help you with research tasks, analyze complex topics, and provide detailed explanations. What would you like to research today?', true);
                }, 500);

            } catch (error) {
                console.error('Failed to create new chat:', error);
            }
        }

        async function loadSession(sessionId) {
            try {
                const response = await fetch(\`/api/session/\${sessionId}\`);
                const session = await response.json();

                currentSessionId = sessionId;
                document.getElementById('currentChatTitle').textContent = session.title;

                // Clear and load messages
                const messagesDiv = document.getElementById('messages');
                messagesDiv.innerHTML = '';

                session.messages.forEach(msg => {
                    addMessage(msg.role, msg.content);
                });

                // Update active state in sidebar
                renderChatHistory();

            } catch (error) {
                console.error('Failed to load session:', error);
            }
        }

        async function deleteSession(sessionId) {
            if (!confirm('Delete this conversation?')) return;

            try {
                await fetch(\`/api/session/\${sessionId}/delete\`, {
                    method: 'DELETE'
                });

                // If deleting current session, create new one
                if (sessionId === currentSessionId) {
                    await createNewChat();
                } else {
                    await loadChatHistory();
                }

            } catch (error) {
                console.error('Failed to delete session:', error);
            }
        }

        async function initializeApp() {
            await loadChatHistory();

            // If no sessions exist, create the first one
            if (allSessions.length === 0) {
                await createNewChat();
            } else {
                // Load the most recent session
                await loadSession(allSessions[0].id);
            }
        }

        function addMessage(role, content, animate = false) {
            const messagesDiv = document.getElementById('messages');
            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${role}\`;

            if (animate && role === 'assistant') {
                messageDiv.style.opacity = '0';
                messageDiv.innerHTML = '';
                messagesDiv.appendChild(messageDiv);

                // Animate typing
                let i = 0;
                const typeChar = () => {
                    if (i < content.length) {
                        messageDiv.innerHTML += content.charAt(i);
                        i++;
                        setTimeout(typeChar, 20);
                    }
                };

                setTimeout(() => {
                    messageDiv.style.opacity = '1';
                    typeChar();
                }, 100);
            } else {
                messageDiv.innerHTML = formatMessage(content);
                messagesDiv.appendChild(messageDiv);
            }

            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }

        function formatMessage(content) {
            // Basic markdown-like formatting
            return content
                .replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>')
                .replace(/\\*(.*?)\\*/g, '<em>$1</em>')
                .replace(/\`(.*?)\`/g, '<code style="background: rgba(102, 126, 234, 0.1); padding: 2px 6px; border-radius: 4px; font-family: monospace;">$1</code>')
                .replace(/\\n/g, '<br>');
        }

        function showTypingIndicator() {
            const messagesDiv = document.getElementById('messages');
            const typingDiv = document.createElement('div');
            typingDiv.className = 'message assistant typing-indicator';
            typingDiv.id = 'typingIndicator';
            typingDiv.innerHTML = \`
                AI is thinking
                <div class="typing-dots">
                    <span></span>
                    <span></span>
                    <span></span>
                </div>
            \`;
            messagesDiv.appendChild(typingDiv);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
            return typingDiv;
        }

        function removeTypingIndicator() {
            const typingIndicator = document.getElementById('typingIndicator');
            if (typingIndicator) {
                typingIndicator.remove();
            }
        }

        async function sendMessage() {
            const input = document.getElementById('messageInput');
            const sendButton = document.getElementById('sendButton');
            const sendText = document.getElementById('sendText');
            const message = input.value.trim();

            if (!message || !currentSessionId || isTyping) return;

            // Update UI
            input.value = '';
            sendButton.disabled = true;
            sendText.textContent = 'Sending...';
            isTyping = true;

            // Add user message
            addMessage('user', message);

            // Show typing indicator
            const typingIndicator = showTypingIndicator();

            try {
                const response = await fetch(\`/api/chat/\${currentSessionId}\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message })
                });

                const data = await response.json();

                // Remove typing indicator
                removeTypingIndicator();

                // Add AI response with animation
                addMessage('assistant', data.response, true);

            } catch (error) {
                console.error('Error:', error);
                removeTypingIndicator();
                addMessage('assistant', 'Sorry, I encountered an error. Please try again.');
            } finally {
                // Reset UI
                sendButton.disabled = false;
                sendText.textContent = 'Send';
                isTyping = false;
                input.focus();
            }
        }

        // Auto-resize input
        const input = document.getElementById('messageInput');
        input.addEventListener('input', function() {
            const sendButton = document.getElementById('sendButton');
            if (this.value.trim()) {
                sendButton.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
            } else {
                sendButton.style.background = 'linear-gradient(135deg, #94a3b8 0%, #64748b 100%)';
            }
        });

        async function updateChatTitle(sessionId, firstMessage) {
            const words = firstMessage.split(' ').slice(0, 6).join(' ');
            const title = words.length > 30 ? words.substring(0, 30) + '...' : words;

            try {
                await fetch(\`/api/session/\${sessionId}/title\`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title })
                });

                document.getElementById('currentChatTitle').textContent = title;
                await loadChatHistory();
            } catch (error) {
                console.error('Failed to update title:', error);
            }
        }

        // Update sendMessage to handle title updates
        const originalSendMessage = sendMessage;
        sendMessage = async function() {
            const input = document.getElementById('messageInput');
            const sendButton = document.getElementById('sendButton');
            const sendText = document.getElementById('sendText');
            const message = input.value.trim();

            if (!message || !currentSessionId || isTyping) return;

            // Check if this is the first user message
            const messages = document.getElementById('messages');
            const isFirstMessage = messages.children.length <= 1;

            // Update UI
            input.value = '';
            sendButton.disabled = true;
            sendText.textContent = 'Sending...';
            isTyping = true;

            // Add user message
            addMessage('user', message);

            // Update title if first message
            if (isFirstMessage) {
                await updateChatTitle(currentSessionId, message);
            }

            // Show typing indicator
            const typingIndicator = showTypingIndicator();

            try {
                const response = await fetch(\`/api/chat/\${currentSessionId}\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message })
                });

                const data = await response.json();

                // Remove typing indicator
                removeTypingIndicator();

                // Add AI response with animation
                addMessage('assistant', data.response, true);

                // Update chat history
                await loadChatHistory();

            } catch (error) {
                console.error('Error:', error);
                removeTypingIndicator();
                addMessage('assistant', 'Sorry, I encountered an error. Please try again.');
            } finally {
                // Reset UI
                sendButton.disabled = false;
                sendText.textContent = 'Send';
                isTyping = false;
                input.focus();
            }
        };

        // Initialize the app
        initializeApp();

        // Focus input after page load
        window.addEventListener('load', () => {
            setTimeout(() => {
                document.getElementById('messageInput').focus();
            }, 100);
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                createNewChat();
            }
        });
    </script>
</body>
</html>`;
}
