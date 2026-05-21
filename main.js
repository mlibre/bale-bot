const axios = require('axios');
const https = require('https');
const http = require('http');
const FormData = require('form-data');
const path = require('path');
const { URL } = require('url');
const { PassThrough } = require('stream');

// ================== CONFIG ==================
const TOKEN = '766686566:G0tqsBZJ7OtKtRFvnOgGFI7i8xsB-Q7jfQk';
const API = `https://tapi.bale.ai/bot${TOKEN}`;

const MAX_CHUNK_MB = 19;
const MAX_CHUNK_SIZE = MAX_CHUNK_MB * 1024 * 1024;
const DOWNLOAD_LIMIT = 500 * 1024 * 1024;

const ALLOWED_PREFIX = ['mlibre', 'The_Mohist'];

// Self-ping configuration
const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.SELF_URL || `http://localhost:${PORT}`;
const PING_URLS = [
	SELF_URL,
	`http://localhost:${PORT}`,
	`http://127.0.0.1:${PORT}`
];

// One-week timer (7 days in ms)
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
let aliveUntil = 0;               // timestamp after which we stop pinging
const PING_INTERVAL_MS = 13 * 60 * 1000;   // 13 minutes (safe margin under 15 min)

let offset = -1;

// ================== RESILIENCE ==================
process.on('uncaughtException', (err) => {
	console.error('❗ Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
	console.error('❗ Unhandled Rejection at:', promise, 'reason:', reason);
});

// ================== API HELPERS ==================
async function callApi(method, params = {}) {
	const url = `${API}/${method}`;
	try {
		const res = await axios.post(url, params, {
			timeout: 30000,
			headers: { 'Content-Type': 'application/json' }
		});
		if (res.data?.ok) return res.data.result;
		throw new Error(`API: ${res.data?.description || 'Unknown'} (code ${res.data?.error_code || '?'})`);
	} catch (err) {
		if (err.response?.data?.description) {
			throw new Error(`API: ${err.response.data.description} (HTTP ${err.response.status})`);
		}
		throw err;
	}
}

async function uploadFile(method, formData) {
	const url = `${API}/${method}`;
	try {
		const res = await axios.post(url, formData, {
			timeout: 120_000,
			headers: formData.getHeaders(),
			maxContentLength: 60 * 1024 * 1024,
		});
		if (res.data?.ok) return res.data.result;
		throw new Error(`API: ${res.data?.description || 'Unknown'} (code ${res.data?.error_code || '?'})`);
	} catch (err) {
		if (err.response?.data?.description) {
			throw new Error(`API: ${err.response.data.description} (HTTP ${err.response.status})`);
		}
		throw err;
	}
}

async function sendMessage(chatId, text, replyTo = null) {
	const params = { chat_id: chatId, text };
	if (replyTo) params.reply_to_message_id = replyTo;
	return callApi('sendMessage', params);
}

async function sendChatAction(chatId, action = 'typing') {
	try { await callApi('sendChatAction', { chat_id: chatId, action }); } catch { }
}

// ================== DOWNLOAD STRATEGIES ==================
async function download_axios_simple(url) {
	return axios({
		method: 'GET', url, responseType: 'arraybuffer',
		timeout: 120_000, maxContentLength: DOWNLOAD_LIMIT,
		httpsAgent: new https.Agent({ rejectUnauthorized: false })
	});
}

async function download_axios_browser(url) {
	return axios({
		method: 'GET', url, responseType: 'arraybuffer',
		timeout: 120_000, maxContentLength: DOWNLOAD_LIMIT,
		headers: {
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
			'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9',
			'Accept-Encoding': 'gzip, deflate, br', 'Referer': 'https://www.google.com/'
		},
		httpsAgent: new https.Agent({ rejectUnauthorized: false })
	});
}

async function download_raw_https(url) {
	return new Promise((resolve, reject) => {
		const parsedUrl = new URL(url);
		const options = {
			hostname: parsedUrl.hostname, port: parsedUrl.port || 443,
			path: parsedUrl.pathname + parsedUrl.search, method: 'GET',
			rejectUnauthorized: false, timeout: 120_000,
			headers: {
				'User-Agent': 'Mozilla/5.0 ...', 'Accept': '*/*',
				'Accept-Language': 'en-US', 'Referer': 'https://www.google.com/'
			}
		};
		const req = https.request(options, (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				return download_raw_https(res.headers.location).then(resolve).catch(reject);
			}
			if (res.statusCode !== 200) return reject(new Error(`Raw HTTPS status ${res.statusCode}`));
			const chunks = [];
			res.on('data', c => chunks.push(c));
			res.on('end', () => resolve({
				data: Buffer.concat(chunks),
				headers: { 'content-type': res.headers['content-type'] || '' }
			}));
		});
		req.on('error', reject);
		req.on('timeout', () => { req.destroy(); reject(new Error('Raw HTTPS timeout')); });
		req.end();
	});
}

async function smartDownload(url) {
	const strategies = [
		{ name: 'simple axios', fn: download_axios_simple },
		{ name: 'browser axios', fn: download_axios_browser },
		{ name: 'raw https', fn: download_raw_https },
	];
	for (const s of strategies) {
		try {
			console.log(`   🔄 Trying: ${s.name}`);
			const res = await s.fn(url);
			return { buffer: Buffer.from(res.data), contentType: res.headers['content-type'] || '' };
		} catch (err) {
			console.log(`   ⚠️  ${s.name} failed: ${err.message}`);
		}
	}
	throw new Error('All download strategies failed');
}

// ================== FILENAME HELPER ==================
function getExtension(url, contentType) {
	try {
		const urlPath = new URL(url).pathname;
		const ext = path.extname(urlPath).toLowerCase();
		if (ext && ext.length > 1 && ext.length <= 10) return ext;
	} catch { }

	const mimeMap = {
		'text/html': '.html', 'text/plain': '.txt', 'text/css': '.css',
		'text/javascript': '.js', 'application/json': '.json',
		'application/pdf': '.pdf', 'application/zip': '.zip',
		'application/x-rar-compressed': '.rar', 'application/x-7z-compressed': '.7z',
		'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
		'image/webp': '.webp', 'video/mp4': '.mp4', 'video/x-matroska': '.mkv',
		'video/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg',
		'audio/wav': '.wav',
	};
	for (const [mime, ext] of Object.entries(mimeMap)) {
		if (contentType.includes(mime)) return ext;
	}
	return '.bin';
}

// ================== FILE SENDING ==================
async function sendSingleFile(chatId, buffer, contentType, originalUrl, replyTo) {
	const ext = getExtension(originalUrl, contentType);
	const filename = `file${ext}`;
	const stream = new PassThrough();
	stream.end(buffer);

	let method, field;
	if (contentType.startsWith('image/')) { method = 'sendPhoto'; field = 'photo'; }
	else if (contentType.startsWith('video/')) { method = 'sendVideo'; field = 'video'; }
	else if (contentType.startsWith('audio/')) { method = 'sendAudio'; field = 'audio'; }
	else { method = 'sendDocument'; field = 'document'; }

	const fd = new FormData();
	fd.append(field, stream, filename);
	fd.append('chat_id', chatId);
	if (originalUrl) fd.append('caption', originalUrl);
	if (replyTo) fd.append('reply_to_message_id', replyTo);

	return uploadFile(method, fd);
}

async function sendFileInChunks(chatId, buffer, originalUrl, replyTo) {
	let ext = '.bin';
	try {
		const urlPath = new URL(originalUrl).pathname;
		const tmp = path.extname(urlPath).toLowerCase();
		if (tmp && tmp.length > 1 && tmp.length <= 10) ext = tmp;
	} catch { }

	const totalParts = Math.ceil(buffer.length / MAX_CHUNK_SIZE);
	console.log(`   📦 Splitting into ${totalParts} parts (max ${MAX_CHUNK_MB} MB each)`);

	for (let i = 0; i < totalParts; i++) {
		const start = i * MAX_CHUNK_SIZE;
		const end = Math.min(start + MAX_CHUNK_SIZE, buffer.length);
		const chunk = buffer.slice(start, end);

		const filename = `part_${i + 1}_of_${totalParts}${ext}`;
		const caption = `[Part ${i + 1}/${totalParts}]`;

		const stream = new PassThrough();
		stream.end(chunk);

		const fd = new FormData();
		fd.append('document', stream, filename);
		fd.append('chat_id', chatId);
		fd.append('caption', caption);
		if (replyTo) fd.append('reply_to_message_id', replyTo);

		console.log(`   📤 Sending ${filename} (${(chunk.length / 1024 / 1024).toFixed(1)} MB)`);
		await uploadFile('sendDocument', fd);
	}

	return { baseName: `part_1_of_${totalParts}${ext}`, totalParts };
}

// ================== SELF-PING ==================
async function keepAlivePing() {
	// Try all configured URLs (custom domain + localhost variants)
	const results = await Promise.allSettled(
		PING_URLS.map(url =>
			axios.get(url, { timeout: 5000 }).then(() => {
				console.log(`🔁 Ping OK: ${url}`);
				return url;
			})
		)
	);
	const succeeded = results.filter(r => r.status === 'fulfilled').map(r => r.value);
	if (succeeded.length === 0) {
		console.warn('⚠️ All keep-alive pings failed');
	}
}

// ================== MAIN HANDLER ==================
async function processMessage(msg) {
	const chatId = msg.chat.id;
	const text = msg.text || '';
	const msgId = msg.message_id;

	const username = (msg.from?.username || '').toLowerCase();
	// Must match at least one allowed prefix
	if (!username || !ALLOWED_PREFIX.some(prefix => username.startsWith(prefix))) {
		return; // silently ignore unauthorized users
	}

	if (!text) return;

	// RESET the one-week timer on every valid message
	aliveUntil = Date.now() + ONE_WEEK_MS;
	console.log(`⏰ Timer reset: alive until ${new Date(aliveUntil).toISOString()}`);

	if (text === '/start') {
		await sendMessage(chatId,
			`👋 Send a direct link (http/https), I'll download it.\n` +
			`- Works even with expired certificates.\n` +
			`- Files > ${MAX_CHUNK_MB} MB are split into parts.\n` +
			`- After parts arrive, I'll explain how to reassemble them.`
		);
		return;
	}

	const match = text.match(/(https?:\/\/[^\s]+)/);
	if (!match) return;

	const targetUrl = match[0];
	console.log(`\n📥 Download from ${chatId}: ${targetUrl}`);

	await sendChatAction(chatId, 'typing');

	try {
		const { buffer, contentType } = await smartDownload(targetUrl);
		const sizeMB = buffer.length / (1024 * 1024);
		console.log(`   ✅ Downloaded ${sizeMB.toFixed(1)} MB, type: ${contentType || 'unknown'}`);

		if (sizeMB > DOWNLOAD_LIMIT / (1024 * 1024)) {
			await sendMessage(chatId, `❌ File too large (${sizeMB.toFixed(1)} MB). Max is 500 MB.`, msgId);
			return;
		}

		if (buffer.length <= MAX_CHUNK_SIZE) {
			await sendSingleFile(chatId, buffer, contentType, targetUrl, msgId);
		} else {
			const { baseName, totalParts } = await sendFileInChunks(chatId, buffer, targetUrl, msgId);
			const ext = path.extname(baseName);
			const originalExt = ext;
			const instructions =
				`✅ All ${totalParts} parts sent.\n\n` +
				`To reassemble the file:\n` +
				`\`\`\`bash\n` +
				`Linux / macOS:\n\`\`\`\ncat part_*${originalExt} > original${originalExt}\n\`\`\`\n` +
				`Windows (Command Prompt):\n\`\`\`\ncopy /b part_*${originalExt} original${originalExt}\n\`\`\`\n` +
				`\`\`\`\n` +
				`(Put all parts in one folder and run the command)`;
			await sendMessage(chatId, instructions, msgId);
		}
	} catch (err) {
		console.error(`   ❌ Error:`, err.message);
		await sendMessage(chatId, `❌ Failed: ${err.message}`, msgId);
	}
}

// ================== HTTP SERVER (for self-ping) ==================
const server = http.createServer((req, res) => {
	res.writeHead(200, { 'Content-Type': 'text/plain' });
	res.end('Bot is alive\n');
});

server.listen(PORT, () => {
	console.log(`🌐 HTTP keep-alive server running on port ${PORT}`);
});

// ================== PERIODIC KEEP-ALIVE (while timer is active) ==================
setInterval(() => {
	const now = Date.now();
	if (aliveUntil > 0 && now < aliveUntil) {
		console.log('📡 Periodic keep-alive ping (timer active)');
		keepAlivePing();
	} else if (aliveUntil > 0 && now >= aliveUntil) {
		console.log('⏹️ One-week timer expired – pings stopped');
		aliveUntil = 0; // reset to avoid logging repeatedly
	}
}, PING_INTERVAL_MS);

// ================== POLLING ==================
async function poll() {
	while (true) {
		try {
			const updates = await callApi('getUpdates', { offset, timeout: 30, limit: 10 });
			if (updates && updates.length) {
				for (const upd of updates) {
					offset = upd.update_id + 1;
					if (upd.message) {
						try {
							await processMessage(upd.message);
						} catch (msgErr) {
							console.error('🔥 Error processing message:', msgErr);
						}
					}
				}
			}
		} catch (err) {
			console.error('Polling error:', err.message);
			await new Promise(r => setTimeout(r, 2000));
		}
	}
}

console.log('🤖 Bale downloader ready (chunks: ' + MAX_CHUNK_MB + ' MB)');
poll().catch(console.error);