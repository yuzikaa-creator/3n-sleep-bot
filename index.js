const express = require('express');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { google } = require('googleapis');

const LINE_CONFIG = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });

const app = express();
const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CONFIG.channelAccessToken
});

const sessions = {};
const imageBuffers = {};

app.get('/', (req, res) => res.send('3N CPAP Bot is running ✅'));

app.post('/webhook', line.middleware(LINE_CONFIG), async (req, res) => {
  // Download รูปทุกรูปทันทีก่อน sendStatus
  const imageEvents = req.body.events.filter(e =>
    e.type === 'message' && e.message.type === 'image'
  );

  await Promise.all(imageEvents.map(async (e) => {
    try {
      const buf = await downloadLineImage(e.message.id);
      const userId = e.source.groupId || e.source.userId || e.source.roomId || 'unknown';
      if (!imageBuffers[userId]) imageBuffers[userId] = {};
      imageBuffers[userId][e.message.id] = buf;
      console.log(`Pre-downloaded ${e.message.id}`);
    } catch (err) {
      console.error(`Pre-download failed ${e.message.id}:`, err.message);
    }
  }));

  res.sendStatus(200);

  for (const event of req.body.events) {
    await handleEvent(event).catch(err => console.error('Event error:', err.message));
  }
});

async function handleEvent(event) {
  if (event.type !== 'message') return;
  const { replyToken, source, message } = event;
  const userId = source.userId || source.groupId || 'unknown';
  const chatId = source.groupId || source.userId || source.roomId;

  if (message.type === 'text') {
    const text = message.text.trim().toLowerCase();

    if (text === 'บันทึก' || text === 'save') {
      const session = sessions[userId] || {};
      if (session.prescription && session.serial) {
        const rowNum = await saveToSheets(session);
        delete sessions[userId];
        const p = session.prescription;
        await push(chatId,
          `✅ บันทึกสำเร็จ! (แถว ${rowNum})\n` +
          `──────────────────\n` +
          `👤 ${p.patient_name || '-'}\n` +
          `🏥 HN: ${p.hn || '-'}\n` +
          `📅 ${p.date || '-'}\n` +
          `💊 ${p.product_name || '-'}\n` +
          `🔲 SN: ${session.serial.serial_number || '-'}\n` +
          `💰 ${p.price || '-'} บาท`
        );
      } else {
        await reply(replyToken, '⚠️ ข้อมูลยังไม่ครบ กรุณาส่งรูปใบสั่งยาและ Serial เครื่องก่อน');
      }
      return;
    }

    if (text === 'ยกเลิก' || text === 'cancel') {
      delete sessions[userId];
      delete imageBuffers[userId];
      await reply(replyToken, '🗑️ ล้างข้อมูลแล้ว เริ่มใหม่ได้เลยครับ');
      return;
    }

    if (text === 'status' || text === 'สถานะ') {
      const session = sessions[userId] || {};
      const has = (k) => session[k] ? '✅' : '⬜';
      await reply(replyToken,
        `📊 สถานะ:\n` +
        `${has('prescription')} ใบสั่งยา\n` +
        `${has('serial')} Serial เครื่อง\n` +
        `${has('mask')} Mask`
      );
      return;
    }
    return;
  }

  if (message.type === 'image') {
    if (!sessions[userId]) sessions[userId] = {};
    const session = sessions[userId];

    try {
      const imageBuffer = imageBuffers[userId]?.[message.id];
      if (!imageBuffer) {
        console.log(`No buffer for ${message.id}`);
        return; // เงียบ ไม่ reply เพราะอาจเป็นรูปที่ส่งพร้อมกัน
      }

      delete imageBuffers[userId][message.id];

      const base64 = imageBuffer.toString('base64');
      const data = await extractFromImage(base64);
      const docType = data.doc_type || 'unknown';

      let msgText = '';

      if (docType === 'prescription') {
        session.prescription = data;
        msgText =
          `📄 อ่านใบสั่งยาแล้ว\n` +
          `──────────────────\n` +
          `👤 ${data.patient_name || '-'}\n` +
          `🏥 HN: ${data.hn || '-'}\n` +
          `🔰 สิทธิ์: ${data.rights || '-'}\n` +
          `💊 ${data.product_name || '-'}\n` +
          `💰 ${data.price || '-'} บาท`;

      } else if (docType === 'serial') {
        session.serial = data;
        msgText =
          `🔲 อ่าน Serial แล้ว\n` +
          `──────────────────\n` +
          `Brand: ${data.brand || '-'}\n` +
          `Model: ${data.model || '-'}\n` +
          `SN: ${data.serial_number || '-'}`;

      } else if (docType === 'mask') {
        session.mask = data;
        msgText =
          `😷 อ่าน Mask แล้ว\n` +
          `──────────────────\n` +
          `Brand: ${data.brand || '-'}\n` +
          `Model: ${data.model || '-'}\n` +
          `Size: ${data.size || '-'}`;

      } else {
        msgText = `⚠️ ระบุประเภทเอกสารไม่ได้`;
      }

      // ถ้าครบ → บันทึก
      if (session.prescription && session.serial) {
        const rowNum = await saveToSheets(session);
        const p = session.prescription;
        msgText =
          `✅ บันทึกสำเร็จ! (แถว ${rowNum})\n` +
          `──────────────────\n` +
          `👤 ${p.patient_name || '-'}\n` +
          `🏥 HN: ${p.hn || '-'}\n` +
          `📅 ${p.date || '-'}\n` +
          `💊 ${p.product_name || '-'}\n` +
          `🔲 SN: ${session.serial.serial_number || '-'}\n` +
          `😷 Mask: ${session.mask ? `${session.mask.model} (${session.mask.size})` : '-'}\n` +
          `💰 ${p.price || '-'} บาท`;
        delete sessions[userId];
        delete imageBuffers[userId];
      }

      // ใช้ push แทน reply เพราะส่งหลายรูปพร้อมกัน replyToken ใช้ได้ครั้งเดียว
      await push(chatId, msgText);

    } catch (err) {
      console.error('Image error:', err.message);
      await push(chatId, `❌ เกิดข้อผิดพลาด: ${err.message.substring(0, 80)}`);
    }
  }
}

async function extractFromImage(base64) {
  const prompt = `คุณคือระบบอ่านเอกสารการขาย CPAP ของ 3N Co., Ltd. โรงพยาบาลราชพิพัฒน์

วิเคราะห์รูปนี้แล้วตอบเป็น JSON เท่านั้น ไม่มีข้อความอื่น ไม่มี markdown:

กฎการแยกประเภท:
- ถ้าเห็นชื่อผู้ป่วย / HN / สิทธิการรักษา / ใบรายการยา / ราคา / โรงพยาบาลราชพิพัฒน์ = prescription
- ถ้าเห็น SN หรือ Serial Number บนป้ายเครื่อง CPAP/BiPAP = serial
- ถ้าเห็นชื่อหน้ากาก + Size S/M/L บนซองหรือกล่อง = mask

ถ้าเป็น prescription:
{"doc_type":"prescription","date":"dd/mm/yyyy","order_no":"","hn":"","patient_name":"","rights":"","product_name":"","quantity":1,"price":"","doctor":""}

ถ้าเป็น serial:
{"doc_type":"serial","brand":"","model":"","serial_number":"","ref":""}

ถ้าเป็น mask:
{"doc_type":"mask","brand":"","model":"","size":"","lot":""}

ตอบ JSON เท่านั้น`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
        { type: 'text', text: prompt }
      ]
    }]
  });

  let text = response.content[0].text.trim();
  text = text.replace(/```json|```/g, '').trim();
  return JSON.parse(text);
}

async function saveToSheets(session) {
  const p = session.prescription || {};
  const s = session.serial || {};
  const m = session.mask || {};

  const row = [
    p.date || '', p.hn || '', p.patient_name || '',
    p.rights || '', p.order_no || '', p.doctor || '',
    p.product_name || '', p.quantity || 1, p.price || '',
    s.brand || '', s.model || '', s.serial_number || '',
    m.brand || '-', m.model || '-', m.size || '-',
    `Spec_${(s.model || '').substring(0, 10)}`,
    '✅ บันทึกแล้ว', 'ระบบ Auto'
  ];

  const result = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'รายการขาย!A:R',
    valueInputOption: 'RAW',
    requestBody: { values: [row] }
  });

  const match = result.data.updates.updatedRange.match(/(\d+)$/);
  return match ? match[1] : '?';
}

async function downloadLineImage(messageId) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const response = await axios.get(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer' }
  );
  return Buffer.from(response.data);
}

async function reply(replyToken, text) {
  await lineClient.replyMessage({
    replyToken,
    messages: [{ type: 'text', text }]
  });
}

async function push(to, text) {
  await lineClient.pushMessage({
    to,
    messages: [{ type: 'text', text }]
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`3N Bot running on port ${PORT}`));
