const axios = require('axios');
const https = require('https');
const http = require('http');
const FormData = require('form-data');
const path = require('path');
const { URL } = require('url');
const { PassThrough } = require('stream');
const { Innertube } = require('youtubei.js');
const { ZipArchive } = require('archiver');

// ================== CONFIG ==================
const TOKEN = '766686566:G0tqsBZJ7OtKtRFvnOgGFI7i8xsB-Q7jfQk';
const API = `https://tapi.bale.ai/bot${TOKEN}`;

const MAX_CHUNK_MB = 19;
const MAX_CHUNK_SIZE = MAX_CHUNK_MB * 1024 * 1024;
const DOWNLOAD_LIMIT = 500 * 1024 * 1024;

// Allowed users – username must start with one of these prefixes
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
let aliveUntil = 0;
const PING_INTERVAL_MS = 13 * 60 * 1000;

let offset = -1;

// YouTube.js session – created once
let ytSession = null;

// ================== RESILIENCE ==================
process.on('uncaughtException', (err) => {
	console.error('❗ Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
	console.error('❗ Unhandled Rejection at:', promise, 'reason:', reason);
});

/**
 * Fallback: use RapidAPI YouTube Media Downloader v2
 */
async function downloadFromRapidApi(videoUrl, videoId) {
	console.log(`   🔄 Trying RapidAPI fallback...`);
	const options = {
		method: 'GET',
		url: 'https://youtube-media-downloader.p.rapidapi.com/v2/video/details',
		params: {
			videoId: videoId,
			urlAccess: 'normal',   // get video/audio URLs
			videos: 'auto',
			audios: 'auto',
			subtitles: false,
			related: false
		},
		headers: {
			'x-rapidapi-host': 'youtube-media-downloader.p.rapidapi.com',
			'x-rapidapi-key': '4bfa8f14fbmsh5b099348bc6e573p101190jsn94b77f4403f8',
			'Content-Type': 'application/json'
		},
		timeout: 55000
	};

	try {
		const response = await axios.get(options.url, {
			params: options.params,
			headers: options.headers,
			timeout: options.timeout
		});

		// Parse the response
		const data = response.data;
		if (!data || !data.videos || !data.videos.items || data.videos.items.length === 0) {
			throw new Error('RapidAPI returned no video files');
		}

		// Choose the highest quality mp4
		const videoItems = data.videos.items.filter(item => item.mimeType?.startsWith('video/mp4'));
		if (videoItems.length === 0) {
			throw new Error('No mp4 video found in RapidAPI response');
		}

		// Sort by quality (height) descending, pick first
		videoItems.sort((a, b) => (b.height || 0) - (a.height || 0));
		const bestVideo = videoItems[0];

		if (!bestVideo.url) {
			throw new Error('No download URL in selected video item');
		}

		console.log(`   📥 Downloading from RapidAPI link (${bestVideo.qualityLabel || bestVideo.quality})`);
		const { buffer, contentType } = await smartDownload(bestVideo.url);
		return { buffer, contentType };
	} catch (err) {
		// Log full error details from RapidAPI
		if (err.response) {
			console.error('   ❌ RapidAPI HTTP Status:', err.response.status);
			console.error('   ❌ RapidAPI Response Body:', JSON.stringify(err.response.data));
		}
		throw new Error(`RapidAPI fallback failed: ${err.message}`);
	}
}

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

// ================== ZIP HELPER ==================
async function zipBuffer(buffer, originalName) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		const archive = new ZipArchive({ zlib: { level: 0 } });
		const output = new PassThrough();
		output.on('data', chunk => chunks.push(chunk));
		output.on('end', () => resolve({
			zipBuffer: Buffer.concat(chunks),
			newName: originalName + '.zip'
		}));
		output.on('error', reject);

		archive.pipe(output);
		archive.append(buffer, { name: originalName });
		archive.finalize();
	});
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
		'application/vnd.android.package-archive': '.apk',
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

// Updated: accepts an optional options.ext to force extension
async function sendFileInChunks(chatId, buffer, originalUrl, replyTo, options = {}) {
	let ext = options.ext || '.bin';
	if (!options.ext) {
		try {
			const urlPath = new URL(originalUrl).pathname;
			const tmp = path.extname(urlPath).toLowerCase();
			if (tmp && tmp.length > 1 && tmp.length <= 10) ext = tmp;
		} catch { }
	}

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

// ================== YOUTUBE HANDLING ==================
function extractYouTubeVideoId(url) {
	try {
		const parsed = new URL(url);
		if (parsed.hostname.includes('youtube.com') && parsed.pathname === '/watch') {
			return parsed.searchParams.get('v');
		}
		if (parsed.hostname === 'youtu.be') {
			return parsed.pathname.split('/')[1]?.split('?')[0] || null;
		}
	} catch { }
	return null;
}

async function handleYouTubeDownload(chatId, videoUrl, replyTo) {
	const videoId = extractYouTubeVideoId(videoUrl);
	if (!videoId) {
		await sendMessage(chatId, '❌ Invalid YouTube URL.', replyTo);
		return;
	}

	await sendChatAction(chatId, 'typing');

	// Try InnerTube clients
	const clientsToTry = ['WEB_CREATOR', 'IOS', 'WEB'];

	for (const client of clientsToTry) {
		try {
			console.log(`   🔄 Trying YouTube client: ${client}`);
			const info = await ytSession.getInfo(videoId, { client });
			const title = info.basic_info.title || 'video';

			if (!info.streaming_data) {
				console.log(`   ⚠️ Client '${client}' returned no streaming data.`);
				continue;
			}

			const format = info.chooseFormat({
				type: 'video+audio',
				quality: 'bestefficiency'
			});

			if (!format) {
				console.log(`   ⚠️ Client '${client}' gave streaming data but no progressive format.`);
				continue;
			}

			console.log(`   🎬 Downloading: ${title} (${format.quality_label || format.quality})`);
			const buffer = await info.download({ format, type: 'buffer' });

			const sizeMB = buffer.length / (1024 * 1024);
			if (sizeMB > DOWNLOAD_LIMIT / (1024 * 1024)) {
				await sendMessage(chatId, `❌ Video too large (${sizeMB.toFixed(1)} MB). Max is 500 MB.`, replyTo);
				return;
			}

			const contentType = format.mime_type?.split(';')[0] || 'video/mp4';

			// --- ZIP wrapper for blocked video extensions (rare) ---
			const ext = getExtension(videoUrl, contentType);
			const blocked = ['.apk', '.exe', '.dmg', '.msi'];
			let finalBuffer = buffer;
			let finalContentType = contentType;
			let finalUrl = videoUrl;
			let forceExt = null;
			if (blocked.includes(ext)) {
				console.log(`   🔐 Wrapping ${ext} in ZIP`);
				const { zipBuffer: zippedBuf, newName } = await zipBuffer(buffer, path.basename(videoUrl) || 'video' + ext);
				finalBuffer = zippedBuf;
				finalContentType = 'application/zip';
				finalUrl = videoUrl + ' (zipped)';
				forceExt = '.zip';
			}

			if (finalBuffer.length <= MAX_CHUNK_SIZE) {
				await sendSingleFile(chatId, finalBuffer, finalContentType, finalUrl, replyTo);
			} else {
				const { baseName, totalParts } = await sendFileInChunks(chatId, finalBuffer, finalUrl, replyTo, { ext: forceExt });
				const fext = path.extname(baseName);
				const instructions =
					`✅ All ${totalParts} parts sent.\n\n` +
					`To reassemble the file:\n` +
					`\`\`\`bash\n` +
					`Linux / macOS:\n\`\`\`\ncat part_*${fext} > original${fext}\n\`\`\`\n` +
					`Windows (Command Prompt):\n\`\`\`\ncopy /b part_*${fext} original${fext}\n\`\`\`\n` +
					`\`\`\``;
				await sendMessage(chatId, instructions, replyTo);
			}
			return;
		} catch (err) {
			console.warn(`   ❌ Client '${client}' failed: ${err.message}`);
		}
	}

	// ---- All InnerTube clients failed → try RapidAPI fallback ----
	try {
		const { buffer, contentType } = await downloadFromRapidApi(videoUrl, videoId);

		const sizeMB = buffer.length / (1024 * 1024);
		if (sizeMB > DOWNLOAD_LIMIT / (1024 * 1024)) {
			await sendMessage(chatId, `❌ Video too large (${sizeMB.toFixed(1)} MB). Max is 500 MB.`, replyTo);
			return;
		}

		// Apply same blocked-extension zipping logic
		const ext = getExtension(videoUrl, contentType);
		const blocked = ['.apk', '.exe', '.dmg', '.msi'];
		let finalBuffer = buffer;
		let finalContentType = contentType;
		let finalUrl = videoUrl;
		let forceExt = null;
		if (blocked.includes(ext)) {
			console.log(`   🔐 Wrapping ${ext} in ZIP`);
			const { zipBuffer: zippedBuf, newName } = await zipBuffer(buffer, path.basename(videoUrl) || 'video' + ext);
			finalBuffer = zippedBuf;
			finalContentType = 'application/zip';
			finalUrl = videoUrl + ' (zipped)';
			forceExt = '.zip';
		}

		if (finalBuffer.length <= MAX_CHUNK_SIZE) {
			await sendSingleFile(chatId, finalBuffer, finalContentType, finalUrl, replyTo);
		} else {
			const { baseName, totalParts } = await sendFileInChunks(chatId, finalBuffer, finalUrl, replyTo, { ext: forceExt });
			const fext = path.extname(baseName);
			const instructions =
				`✅ All ${totalParts} parts sent.\n\n` +
				`To reassemble the file:\n` +
				`\`\`\`bash\n` +
				`Linux / macOS:\n\`\`\`\ncat part_*${fext} > original${fext}\n\`\`\`\n` +
				`Windows (Command Prompt):\n\`\`\`\ncopy /b part_*${fext} original${fext}\n\`\`\`\n` +
				`\`\`\``;
			await sendMessage(chatId, instructions, replyTo);
		}
	} catch (fallbackErr) {
		console.error(`   ❌ RapidAPI fallback failed: ${fallbackErr.message}`);
		// Improved error message – hints at possible restrictions
		await sendMessage(chatId,
			'❌ Unable to download this YouTube video.\n\n' +
			'Possible reasons:\n' +
			'• Age‑restricted / members‑only video\n' +
			'• Regional blocking\n' +
			'• The video is a livestream or upcoming premiere\n' +
			'• RapidAPI quota exhausted or plan limitation\n\n' +
			'Try again later or with a different video.',
			replyTo
		);
	}
}

// ================== MAIN HANDLER ==================
async function processMessage(msg) {
	const chatId = msg.chat.id;
	const text = msg.text || '';
	const msgId = msg.message_id;

	const username = (msg.from?.username || '').toLowerCase();
	if (!username || !ALLOWED_PREFIX.some(prefix => username.startsWith(prefix))) {
		return;
	}

	if (!text) return;

	aliveUntil = Date.now() + ONE_WEEK_MS;
	console.log(`⏰ Timer reset: alive until ${new Date(aliveUntil).toISOString()}`);

	if (text === '/start') {
		await sendMessage(chatId, `👋`);
		return;
	}

	const match = text.match(/(https?:\/\/[^\s]+)/);
	if (!match) return;

	let targetUrl = match[0];
	console.log(`\n📥 Download from ${chatId}: ${targetUrl}`);

	const videoId = extractYouTubeVideoId(targetUrl);
	if (videoId) {
		try {
			await handleYouTubeDownload(chatId, targetUrl, msgId);
		} catch (err) {
			console.error(`   ❌ YouTube error:`, err.message);
			await sendMessage(chatId, `❌ YouTube download failed: ${err.message}`, msgId);
		}
		return;
	}

	// Non-YouTube download
	await sendChatAction(chatId, 'typing');

	try {
		let { buffer, contentType } = await smartDownload(targetUrl);
		const ext = getExtension(targetUrl, contentType);

		const BLOCKED_EXTENSIONS = ['.apk', '.exe', '.dmg', '.msi'];
		let forceExt = null;
		if (BLOCKED_EXTENSIONS.includes(ext)) {
			console.log(`   🔐 Wrapping ${ext} in ZIP`);
			const { zipBuffer: zippedBuf, newName } = await zipBuffer(buffer, path.basename(targetUrl) || 'file' + ext);
			buffer = zippedBuf;
			contentType = 'application/zip';
			targetUrl = targetUrl + ' (zipped)';
			forceExt = '.zip';
		}

		const sizeMB = buffer.length / (1024 * 1024);
		console.log(`   ✅ Downloaded ${sizeMB.toFixed(1)} MB, type: ${contentType || 'unknown'}`);

		if (sizeMB > DOWNLOAD_LIMIT / (1024 * 1024)) {
			await sendMessage(chatId, `❌ File too large (${sizeMB.toFixed(1)} MB). Max is 500 MB.`, msgId);
			return;
		}

		if (buffer.length <= MAX_CHUNK_SIZE) {
			await sendSingleFile(chatId, buffer, contentType, targetUrl, msgId);
		} else {
			const { baseName, totalParts } = await sendFileInChunks(chatId, buffer, targetUrl, msgId, { ext: forceExt });
			const fext = path.extname(baseName);
			const instructions =
				`✅ All ${totalParts} parts sent.\n\n` +
				`To reassemble the file:\n` +
				`\`\`\`bash\n` +
				`Linux / macOS:\n\`\`\`\ncat part_*${fext} > original${fext}\n\`\`\`\n` +
				`Windows (Command Prompt):\n\`\`\`\ncopy /b part_*${fext} original${fext}\n\`\`\`\n` +
				`\`\`\``;
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

// ================== PERIODIC KEEP-ALIVE ==================
setInterval(() => {
	const now = Date.now();
	if (aliveUntil > 0 && now < aliveUntil) {
		console.log('📡 Periodic keep-alive ping (timer active)');
		keepAlivePing();
	} else if (aliveUntil > 0 && now >= aliveUntil) {
		console.log('⏹️ One-week timer expired – pings stopped');
		aliveUntil = 0;
	}
}, PING_INTERVAL_MS);

// ================== INITIALIZATION ==================
async function initialize() {
	try {
		const cookies = process.env.INNERTUBE_COOKIES || "GPS=1; PREF=f4=4000000&f6=40000000&tz=Asia.Tehran&f7=100; CONSISTENCY=AHzIXryfeuAoyuL_2TYtLhxTd0bcxG0O0VBRl4vlanthgh7-SNkGqidQPSK5ap_C1QIhZfkPL3a8hxD8DbxerhNSaCumqwEOhWBbvJrXkq46C1FYLB8BJ7E; YSC=lWTGcUFmF94; VISITOR_INFO1_LIVE=oUJ4sZLQuOU; VISITOR_PRIVACY_METADATA=CgJJUhIEGgAgTw%3D%3D; __Secure-YNID=18.YT=kk1GwMMHLS_l7C03c_alXsVtNAE-a-ZewG1LaOO7EQJRnFoyFVjRN4drD64h9rWG0Pf2C15mjAfFUq-wvNjYIegz-Bh7E2Vtjx6s5MZM0FyYAeuia1ifLVlFTWCLzKUCa0iAj7s5Ho0NXVg6bFhJDhUnvTr7JRWwbDlf3TdS1NCWwOR0frkmgI55Wo_nPWYUvKfvMKMAoNLOVAtXLEgo_3NJeKJJJRC-RBLMj-ukx_FbvvBRMdM_tySf3A19p_pr5BdHkZsauJKaQzGba_Hboxq_0d9lwMALPutJ70FCDVS-BSu0Cni6fPgidz_LwARmjNMHjl9rz2Vr7SSWpGR-bg; __Secure-ROLLOUT_TOKEN=CKCk6tCPxpiwjgEQj5nu7I_LlAMY7LK57Y_LlAM%3D";
		ytSession = await Innertube.create({
			lang: 'en',
			location: 'US',
			retrieve_player: true,
			cookies: cookies   // ← uncomment if you have a valid cookie string/file
		});
		console.log('✅ YouTube session created');
	} catch (err) {
		console.error('❌ Failed to create YouTube session:', err.message);
		console.log('⚠️ YouTube downloads will not work, but bot remains alive.');
	}
}

// ================== POLLING ==================
async function poll() {
	await initialize();
	console.log('🤖 Bale downloader ready (chunks: ' + MAX_CHUNK_MB + ' MB)');
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

poll().catch(console.error);