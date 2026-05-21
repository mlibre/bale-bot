const https = require('https');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ================== CONFIG ==================
const TOKEN = '766686566:G0tqsBZJ7OtKtRFvnOgGFI7i8xsB-Q7jfQk';
const API = `https://tapi.bale.ai/bot${TOKEN}`;
const MAX_SIZE_MB = 50;               // Bale’s upload limit

let offset = 0;

// ================== HELPERS ==================
async function callApi(method, params = {}, form = false) {
  const url = `${API}/${method}`;
  let config = { method: 'POST', url, timeout: 30000 };

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

    // API returned { ok: false }
    const desc = res.data?.description || 'Unknown error';
    throw new Error(`API error: ${desc} (code ${res.data?.error_code || '?'})`);
  } catch (err) {
    // If axios threw (network / status >= 400), extract Bale’s description
    if (err.response?.data?.description) {
      throw new Error(
        `API error: ${err.response.data.description} (HTTP ${err.response.status})`
      );
    }
    // Otherwise re‑throw the original (connection / timeout etc.)
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
  } catch {
    // Not critical – simply ignore
  }
}

async function downloadFile(urlStr) {
  const response = await axios({
    method: 'GET',
    url: urlStr,
    responseType: 'arraybuffer',
    timeout: 120_000,
    maxContentLength: 60 * 1024 * 1024,
    httpsAgent: new https.Agent({ rejectUnauthorized: false })  // ← bypass SSL check
  });
  const buffer = Buffer.from(response.data);
  const contentType = response.headers['content-type'] || '';
  return { buffer, contentType };
}

function getExtension(urlStr, contentType) {
  try {
    const urlPath = new URL(urlStr).pathname;
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

  // Prepare a readable stream for FormData
  const { PassThrough } = require('stream');
  const stream = new PassThrough();
  stream.end(buffer);

  const formParams = {
    chat_id: chatId,
    caption: originalUrl,
  };
  if (replyTo) formParams.reply_to_message_id = replyTo;

  let method, fieldName;
  if (contentType.startsWith('image/')) {
    method = 'sendPhoto';
    fieldName = 'photo';
  } else if (contentType.startsWith('video/')) {
    method = 'sendVideo';
    fieldName = 'video';
  } else if (contentType.startsWith('audio/')) {
    method = 'sendAudio';
    fieldName = 'audio';
  } else {
    method = 'sendDocument';
    fieldName = 'document';
  }

  const fd = new FormData();
  fd.append(fieldName, stream, filename);
  for (const [k, v] of Object.entries(formParams)) fd.append(k, v);

  return callApi(method, Object.fromEntries(fd), true);   // use FormData
}

// ================== MAIN LOGIC ==================
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const msgId = msg.message_id;

  if (!text) return;

  if (text === '/start') {
    await sendMessage(chatId,
      '👋 Send me a direct link (http/https) and I’ll download & forward the file.\nMax size: 50 MB');
    return;
  }

  const match = text.match(/(https?:\/\/[^\s]+)/);
  if (!match) return;

  const targetUrl = match[0];
  console.log(`\n📥 Download request from ${chatId}: ${targetUrl}`);

  // Show typing (ignored if fails)
  await sendChatAction(chatId, 'typing');

  try {
    const { buffer, contentType } = await downloadFile(targetUrl);

    const sizeMB = buffer.length / (1024 * 1024);
    console.log(`   Size: ${sizeMB.toFixed(2)} MB`);

    if (sizeMB > MAX_SIZE_MB) {
      await sendMessage(chatId,
        `❌ File too large (${sizeMB.toFixed(2)} MB). Bale allows up to ${MAX_SIZE_MB} MB.`,
        msgId);
      return;
    }

    await sendFile(chatId, buffer, contentType, targetUrl, msgId);
    console.log(`   ✅ Sent successfully`);
  } catch (err) {
    console.error(`   ❌ Error:`, err.message);
    await sendMessage(chatId, `❌ Failed: ${err.message}`, msgId);
  }
}

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
          if (upd.message) await handleMessage(upd.message);
        }
      }
    } catch (err) {
      console.error('Polling error:', err.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ================== START ==================
console.log('🤖 Bot started. Send a link in Bale…');
poll().catch(console.error);