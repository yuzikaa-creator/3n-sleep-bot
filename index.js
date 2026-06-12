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

// Session: เก็บข้อมูลรอครบ per user
// { userId: { prescription:{}, serial:{}, mask:{} } }
const sessions = {};

app.get('/', (req, res) => res.send('3N CPAP Bot is running ✅'));

app.post('/webhook', line.middleware(LINE_CONFIG), async (req, res) => {
  res.sendStatus(200);
  for (const event of req.body.events) {
    await handleEvent(event).catch(err => console.error('Event error:', err.message));
  }
});

async function handleEvent(event) {
  if (event.type !== 'message') return;
  const { replyToken, source, message } = event;
  const userId = source.userId || source.groupId || 'unknown';

  // ── รับข้อความ ──────────────────────────────────────────────
  if (message.type === 'text') {
    const text = message.text.trim().toLowerCase();

    if (text === 'บันทึก' || text === 'save') {
      const session = sessions[userId] || {};
      if (session.prescription && session.serial) {
        const rowNum = await saveToSheets(session);
        delete sessions[userId];
        const p = session.prescription;
        await reply(replyToken,
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
      await reply(replyToken, '🗑️ ล้างข้อมูลแล้ว เริ่มใหม่ได้เลยครับ');
      return;
    }

    if (text === 'status' || text === 'สถานะ') {
      const session = sessions[userId] || {};
      const has = (k) => session[k] ? '✅' : '⬜';
      await reply(replyToken,
        `📊 สถานะข้อมูลปัจจุบัน:\n` +
        `${has('prescription')} ใบสั่งยา\n` +
        `${has('serial')} Serial เครื่อง\n` +
        `${has('mask')} Mask\n\n` +
        (session.prescription && session.serial
          ? `พร้อมบันทึก! พิมพ์ "บันทึก" หรือส่งรูป Mask ต่อได้เลย`
          : `ยังไม่ครบ กรุณาส่งรูปให้ครบ`)
      );
      return;
    }
    return;
  }

  // ── รับรูป ───────────────────────────────────────────────────
  if (message.type === 'image') {
    if (!sessions[userId]) sessions[userId] = {};
    const session = sessions[userId];

    try {
      // Download รูปจาก Line
      const imageBuffer = await downloadLineImage(message.id);
      const base64 = imageBuffer.toString('base64');

      // Claude อ่านรูป
      const data = await extractFromImage(base64);
      const docType = data.doc_type || 'unknown';

      let replyText = '';

      if (docType === 'prescription') {
        session.prescription = data;
        replyText =
          `📄 อ่านใบสั่งยาแล้ว\n` +
          `──────────────────\n` +
          `👤 ${data.patient_name || '-'}\n` +
          `🏥 HN: ${data.hn || '-'}\n` +
          `🔰 สิทธิ์: ${data.rights || '-'}\n` +
          `💊 ${data.product_name || '-'}\n` +
          `💰 ${data.price || '-'} บาท\n\n` +
          `⏭️ ส่งรูป Serial เครื่องต่อได้เลย`;

      } else if (docType === 'serial') {
        session.serial = data;
        replyText =
          `🔲 อ่าน Serial แล้ว\n` +
          `──────────────────\n` +
          `Brand: ${data.brand || '-'}\n` +
          `Model: ${data.model || '-'}\n` +
          `SN: ${data.serial_number || '-'}\n\n` +
          (session.prescription
            ? `⏭️ ส่งรูป Mask ต่อได้ หรือพิมพ์ "บันทึก" เลย`
            : `⏭️ ส่งรูปใบสั่งยาด้วยครับ`);

      } else if (docType === 'mask') {
        session.mask = data;
        replyText =
          `😷 อ่าน Mask แล้ว\n` +
          `──────────────────\n` +
          `Brand: ${data.brand || '-'}\n` +
          `Model: ${data.model || '-'}\n` +
          `Size: ${data.size || '-'}\n\n` +
          (session.prescription && session.serial
            ? `กำลังบันทึก...`
            : `⏭️ ยังขาดรูปใบสั่งยาหรือ Serial`);

      } else {
        replyText = `⚠️ ระบุประเภทเอกสารไม่ได้\nกรุณาส่งรูป: ใบสั่งยา / Serial เครื่อง / ซองหน้ากาก`;
      }

      // ถ้าครบแล้ว บันทึกทันที
      if (session.prescription && session.serial) {
        const rowNum = await saveToSheets(session);
        const p = session.prescription;
        replyText =
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
      }

      await reply(replyToken, replyText);

    } catch (err) {
      console.error('Image error:', err.message);
      await reply(replyToken, `❌ เกิดข้อผิดพลาด: ${err.message.substring(0, 80)}`);
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
{"doc_type":"prescription","date":"วันที่ในรูป dd/mm/yyyy","order_no":"เลขที่ใบสั่ง","hn":"HN","patient_name":"ชื่อผู้ป่วย","rights":"สิทธิการรักษา","product_name":"ชื่อสินค้าที่สั่ง","quantity":1,"price":"ราคา ตัวเลขเท่านั้น","doctor":"ชื่อแพทย์"}

ถ้าเป็น serial:
{"doc_type":"serial","brand":"ResMed หรือ Hingmed หรือ Ventmed","model":"รุ่นสินค้า","serial_number":"SN number","ref":"REF number ถ้ามี"}

ถ้าเป็น mask:
{"doc_type":"mask","brand":"แบรนด์","model":"รุ่น","size":"S หรือ M หรือ L หรือ XL","lot":"LOT number ถ้ามี"}

ตอบ JSON เท่านั้น ห้ามมีข้อความอื่น`;

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
    p.date || '',
    p.hn || '',
    p.patient_name || '',
    p.rights || '',
    p.order_no || '',
    p.doctor || '',
    p.product_name || '',
    p.quantity || 1,
    p.price || '',
    s.brand || '',
    s.model || '',
    s.serial_number || '',
    m.brand || '-',
    m.model || '-',
    m.size || '-',
    `Spec_${(s.model || '').substring(0, 10)}`,
    '✅ บันทึกแล้ว',
    'ระบบ Auto'
  ];

  const result = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'รายการขาย!A:R',
    valueInputOption: 'RAW',
    requestBody: { values: [row] }
  });

  const updatedRange = result.data.updates.updatedRange;
  const match = updatedRange.match(/(\d+)$/);
  return match ? match[1] : '?';
}

async function downloadLineImage(messageId) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  console.log(`Downloading image ${messageId} with token: ${token ? token.substring(0,20)+'...' : 'MISSING'}`);
  const response = await axios.get(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer'
    }
  );
  return Buffer.from(response.data);
}

async function reply(replyToken, text) {
  await lineClient.replyMessage({
    replyToken,
    messages: [{ type: 'text', text }]
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`3N Bot running on port ${PORT}`));
