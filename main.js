const axios = require('axios');
const https = require('https');
const FormData = require('form-data');
const path = require('path');
const { URL } = require('url');
const { PassThrough } = require('stream');

// ================== CONFIG ==================
const TOKEN = '766686566:G0tqsBZJ7OtKtRFvnOgGFI7i8xsB-Q7jfQk';
const API = `https://tapi.bale.ai/bot${TOKEN}`;

const MAX_FILE_MB = 45;           // Bale allows up to 50, we use 45 for safety
const MAX_CHUNK_SIZE = MAX_FILE_MB * 1024 * 1024;

const DOWNLOAD_LIMIT = 500 * 1024 * 1024;   // we'll download files up to 500MB

let offset = 0;

// ================== API HELPERS ==================
async function callApi(method, params = {}, form = false) {
  const url = `${API}/${method}`;
  const config = { method: 'POST', url, timeout: 30000 };

  if (form) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(params)) fd.append(k, v);
    config.headers = fd.getHeaders();
    config.data = fd;
  } else {
    config.headers = { 'Content-Type': 'application/json' };
    config.data = params;
  }

  try {
    const res = await axios(config);
    if (res.data?.ok) return res.data.result;
    const desc = res.data?.description || 'Unknown error';
    throw new Error(`API: ${desc} (code ${res.data?.error_code || '?'})`);
  } catch (err) {
    if (err.response?.data?.description) {
      throw new Error(`API: ${err.response.data.description} (HTTP ${err.response.status})`);
    }
    throw err;
  }
}

async function sendMessage(chatId, text, replyTo = null) {
  const p = { chat_id: chatId, text };
  if (replyTo) p.reply_to_message_id = replyTo;
  return callApi('sendMessage', p);
}

async function sendChatAction(chatId, action = 'typing') {
  try {
    await callApi('sendChatAction', { chat_id: chatId, action });
  } catch { /* ignore */ }
}

// ================== DOWNLOAD STRATEGIES ==================
// Strategy 1: basic axios, ignore SSL
async function download_axios_simple(url) {
  return axios({
    method: 'GET',
    url,
    responseType: 'arraybuffer',
    timeout: 120_000,
    maxContentLength: DOWNLOAD_LIMIT,
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  });
}

// Strategy 2: axios with full browser headers
async function download_axios_browser(url) {
  return axios({
    method: 'GET',
    url,
    responseType: 'arraybuffer',
    timeout: 120_000,
    maxContentLength: DOWNLOAD_LIMIT,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': 'https://www.google.com/'
    },
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  });
}

// Strategy 3: raw https module (no axios)
async function download_raw_https(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      rejectUnauthorized: false,
      timeout: 120_000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.google.com/'
      }
    };

    const req = https.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // follow redirect
        download_raw_https(res.headers.location)
          .then(resolve)
          .catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Raw HTTPS: status ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ data: buffer, headers: { 'content-type': res.headers['content-type'] || '' } });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Raw HTTPS timeout'));
    });
    req.end();
  });
}

// Try strategies one by one
async function smartDownload(url) {
  const strategies = [
    { name: 'simple axios', fn: download_axios_simple },
    { name: 'browser axios', fn: download_axios_browser },
    { name: 'raw https', fn: download_raw_https },
  ];

  for (const strat of strategies) {
    try {
      console.log(`   🔄 Trying download strategy: ${strat.name}`);
      const response = await strat.fn(url);
      const buffer = Buffer.from(response.data);
      const contentType = response.headers['content-type'] || '';
      return { buffer, contentType };
    } catch (err) {
      console.log(`   ⚠️  ${strat.name} failed: ${err.message}`);
    }
  }
  throw new Error('All download strategies failed.');
}

// ================== FILE TYPE & SENDING ==================
function getExtension(url, contentType) {
  try {
    const urlPath = new URL(url).pathname;
    const ext = path.extname(urlPath).toLowerCase();
    if (ext) return ext;
  } catch { /* ignore */ }

  const map = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'audio/mpeg': '.mp3', 'application/pdf': '.pdf'
  };
  for (const [mime, e] of Object.entries(map))
    if (contentType.includes(mime)) return e;
  return '.bin';
}

async function sendFile(chatId, buffer, contentType, originalUrl, replyTo) {
  const ext = getExtension(originalUrl, contentType);
  const filename = `file${ext}`;

  const stream = new PassThrough();
  stream.end(buffer);

  let method, field;
  if (contentType.startsWith('image/')) {
    method = 'sendPhoto'; field = 'photo';
  } else if (contentType.startsWith('video/')) {
    method = 'sendVideo'; field = 'video';
  } else if (contentType.startsWith('audio/')) {
    method = 'sendAudio'; field = 'audio';
  } else {
    method = 'sendDocument'; field = 'document';
  }

  const formParams = { chat_id: chatId, caption: originalUrl };
  if (replyTo) formParams.reply_to_message_id = replyTo;

  const fd = new FormData();
  fd.append(field, stream, filename);
  for (const [k, v] of Object.entries(formParams)) fd.append(k, v);

  return callApi(method, Object.fromEntries(fd), true);
}

async function sendFileInChunks(chatId, buffer, originalUrl, replyTo) {
  const totalParts = Math.ceil(buffer.length / MAX_CHUNK_SIZE);
  console.log(`   📦 Splitting into ${totalParts} parts (max ${MAX_FILE_MB} MB each)`);

  for (let i = 0; i < totalParts; i++) {
    const start = i * MAX_CHUNK_SIZE;
    const end = Math.min(start + MAX_CHUNK_SIZE, buffer.length);
    const chunk = buffer.slice(start, end);

    const stream = new PassThrough();
    stream.end(chunk);

    const filename = `part_${i + 1}_of_${totalParts}.bin`;
    const caption = `${originalUrl}\n[Part ${i + 1}/${totalParts}]`;

    const fd = new FormData();
    fd.append('document', stream, filename);
    fd.append('chat_id', chatId);
    fd.append('caption', caption);
    if (replyTo) fd.append('reply_to_message_id', replyTo);

    console.log(`   📤 Sending part ${i + 1}/${totalParts} (${(chunk.length / 1024 / 1024).toFixed(1)} MB)`);
    await callApi('sendDocument', Object.fromEntries(fd), true);
  }
}

// ================== MESSAGE HANDLING ==================
async function processMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const msgId = msg.message_id;

  if (!text) return;

  if (text === '/start') {
    return sendMessage(chatId,
      `👋 Send me any direct link (http/https) and I’ll download it.\n` +
      `- Works with expired certificates.\n` +
      `- Files > ${MAX_FILE_MB} MB are sent in parts.\n` +
      `- Supports: images, videos, audio, documents.`
    );
  }

  const match = text.match(/(https?:\/\/[^\s]+)/);
  if (!match) return;

  const targetUrl = match[0];
  console.log(`\n📥 Download request from ${chatId}: ${targetUrl}`);

  await sendChatAction(chatId, 'typing');

  try {
    // Download with fallback strategies
    const { buffer, contentType } = await smartDownload(targetUrl);
    const sizeMB = buffer.length / (1024 * 1024);
    console.log(`   ✅ Downloaded ${sizeMB.toFixed(1)} MB, type: ${contentType || 'unknown'}`);

    if (sizeMB > DOWNLOAD_LIMIT / (1024 * 1024)) {
      await sendMessage(chatId, `❌ File too large (${sizeMB.toFixed(1)} MB). Maximum is 500 MB.`, msgId);
      return;
    }

    // If under the chunk limit, send as normal
    if (buffer.length <= MAX_CHUNK_SIZE) {
      await sendFile(chatId, buffer, contentType, targetUrl, msgId);
    } else {
      // Split into parts and send
      await sendFileInChunks(chatId, buffer, targetUrl, msgId);
    }
  } catch (err) {
    console.error(`   ❌ Error:`, err.message);
    await sendMessage(chatId, `❌ Failed: ${err.message}`, msgId);
  }
}

// ================== POLLING LOOP ==================
async function poll() {
  while (true) {
    try {
      const updates = await callApi('getUpdates', {
        offset,
        timeout: 30,
        limit: 10,
      });
      if (updates && updates.length) {
        for (const upd of updates) {
          offset = upd.update_id + 1;
          if (upd.message) await processMessage(upd.message);
        }
      }
    } catch (err) {
      console.error('Polling error:', err.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ================== START ==================
console.log('🤖 Ultra-resilient Bale download bot started...');
poll().catch(console.error);