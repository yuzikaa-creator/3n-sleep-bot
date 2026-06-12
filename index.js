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

// session: { userId: { step: 1/2/3, prescription:{}, serial:{}, mask:{} } }
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
  const userId = source.groupId || source.userId || 'unknown';
  const chatId = source.groupId || source.userId || 'unknown';

  // ── รับข้อความ ──────────────────────────────────────────────
  if (message.type === 'text') {
    const text = message.text.trim();

    if (text === '1') {
      sessions[userId] = { step: 1 };
      await reply(replyToken, '📄 ส่งรูปใบสั่งยาได้เลยครับ');
      return;
    }

    if (text === '2') {
      if (!sessions[userId]?.prescription) {
        await reply(replyToken, '⚠️ กรุณาส่งใบสั่งยาก่อน (พิมพ์ 1)');
        return;
      }
      sessions[userId].step = 2;
      await reply(replyToken, '🔲 ส่งรูป Serial เครื่องได้เลยครับ');
      return;
    }

    if (text === '3') {
      if (!sessions[userId]?.serial) {
        await reply(replyToken, '⚠️ กรุณาส่ง Serial เครื่องก่อน (พิมพ์ 2)');
        return;
      }
      sessions[userId].step = 3;
      await reply(replyToken, '😷 ส่งรูปหน้ากากได้เลยครับ (หรือพิมพ์ บันทึก ถ้าไม่มีหน้ากาก)');
      return;
    }

    if (text === 'บันทึก' || text === 'save') {
      const session = sessions[userId] || {};
      if (session.prescription && session.serial) {
        const rowNum = await saveToSheets(session);
        delete sessions[userId];
        const p = session.prescription;
        await push(chatId,
          `✅ บันทึกสำเร็จ! (แถว ${rowNum})\n──────────────────\n` +
          `👤 ${p.patient_name||'-'}\n🏥 HN: ${p.hn||'-'}\n` +
          `📅 ${p.date||'-'}\n💊 ${p.product_name||'-'}\n` +
          `🔲 SN: ${session.serial.serial_number||'-'}\n` +
          `💰 ${p.price||'-'} บาท`
        );
      } else {
        await reply(replyToken, '⚠️ ข้อมูลยังไม่ครบ\nพิมพ์ 1 → ส่งใบสั่งยา\nพิมพ์ 2 → ส่ง Serial');
      }
      return;
    }

    if (text === 'ยกเลิก' || text === 'cancel' || text === '0') {
      delete sessions[userId];
      await reply(replyToken, '🗑️ ล้างข้อมูลแล้ว\n\nพิมพ์ 1 เพื่อเริ่มใหม่');
      return;
    }

    if (text === 'status' || text === 'สถานะ') {
      const s = sessions[userId] || {};
      const has = (k) => s[k] ? '✅' : '⬜';
      await reply(replyToken,
        `📊 สถานะ:\n${has('prescription')} 1. ใบสั่งยา\n` +
        `${has('serial')} 2. Serial เครื่อง\n${has('mask')} 3. Mask\n\n` +
        `พิมพ์ 1/2/3 เพื่อส่งรูป\nพิมพ์ "บันทึก" เมื่อพร้อม`
      );
      return;
    }

    // คำสั่งหลัก
    if (text === 'help' || text === 'ช่วยเหลือ') {
      await reply(replyToken,
        `🤖 3NEXA AI — วิธีใช้\n──────────────────\n` +
        `พิมพ์ 1 → ส่งรูปใบสั่งยา\n` +
        `พิมพ์ 2 → ส่งรูป Serial เครื่อง\n` +
        `พิมพ์ 3 → ส่งรูปหน้ากาก\n` +
        `พิมพ์ "บันทึก" → บันทึกลง Sheet\n` +
        `พิมพ์ "สถานะ" → ดูข้อมูลที่อ่านแล้ว\n` +
        `พิมพ์ 0 → ยกเลิก/เริ่มใหม่`
      );
      return;
    }
    return;
  }

  // ── รับรูป ───────────────────────────────────────────────────
  if (message.type === 'image') {
    const session = sessions[userId];

    if (!session || !session.step) {
      await push(chatId, `⚠️ กรุณาพิมพ์ก่อนส่งรูป:\n1 = ใบสั่งยา\n2 = Serial เครื่อง\n3 = หน้ากาก`);
      return;
    }

    try {
      const imageBuffer = await downloadLineImage(message.id);
      const base64 = imageBuffer.toString('base64');
      const data = await extractFromImage(base64, session.step);

      let msgText = '';

      if (session.step === 1) {
        session.prescription = data;
        session.step = null;
        msgText = `📄 อ่านใบสั่งยาแล้ว\n──────────────────\n` +
          `👤 ${data.patient_name||'-'}\n🏥 HN: ${data.hn||'-'}\n` +
          `🔰 สิทธิ์: ${data.rights||'-'}\n💊 ${data.product_name||'-'}\n` +
          `💰 ${data.price||'-'} บาท\n\n` +
          `⏭️ พิมพ์ 2 เพื่อส่งรูป Serial เครื่อง`;

      } else if (session.step === 2) {
        session.serial = data;
        session.step = null;
        msgText = `🔲 อ่าน Serial แล้ว\n──────────────────\n` +
          `Brand: ${data.brand||'-'}\nModel: ${data.model||'-'}\nSN: ${data.serial_number||'-'}\n\n` +
          `⏭️ พิมพ์ 3 ส่งรูปหน้ากาก หรือพิมพ์ "บันทึก" เลย`;

      } else if (session.step === 3) {
        session.mask = data;
        session.step = null;
        // ถ้ามี prescription + serial แล้ว → บันทึกทันที
        if (session.prescription && session.serial) {
          const rowNum = await saveToSheets(session);
          const p = session.prescription;
          msgText = `✅ บันทึกสำเร็จ! (แถว ${rowNum})\n──────────────────\n` +
            `👤 ${p.patient_name||'-'}\n🏥 HN: ${p.hn||'-'}\n` +
            `📅 ${p.date||'-'}\n💊 ${p.product_name||'-'}\n` +
            `🔲 SN: ${session.serial.serial_number||'-'}\n` +
            `😷 ${data.model||'-'} (${data.size||'-'})\n` +
            `💰 ${p.price||'-'} บาท`;
          delete sessions[userId];
        } else {
          msgText = `😷 อ่าน Mask แล้ว\nBrand: ${data.brand||'-'}\nModel: ${data.model||'-'}\nSize: ${data.size||'-'}`;
        }
      }

      // ถ้าครบ prescription + serial (กรณีส่งแค่ 2 รูป แล้วมาพิมพ์บันทึก)
      if (sessions[userId]?.prescription && sessions[userId]?.serial && !sessions[userId]?.step) {
        // รอให้ user พิมพ์ บันทึก หรือส่งรูป Mask
      }

      await push(chatId, msgText);

    } catch (err) {
      console.error('Image error:', err.message);
      await push(chatId, `❌ อ่านรูปไม่ได้: ${err.message.substring(0,60)}\nกรุณาส่งรูปใหม่`);
    }
  }
}

async function extractFromImage(base64, step) {
  // บอก Claude ว่ารูปนี้คือประเภทอะไร ตามที่ user บอก
  const typeHint = step === 1 ? 'ใบสั่งยา/ใบรายการยาของโรงพยาบาล'
    : step === 2 ? 'ป้าย Serial Number ของเครื่อง CPAP หรือ BiPAP'
    : 'ซองหรือกล่องหน้ากาก CPAP Mask';

  const prompt = `คุณคือระบบอ่านเอกสาร CPAP ของ 3N Co., Ltd.
รูปนี้คือ: ${typeHint}
ตอบเป็น JSON เท่านั้น ไม่มีข้อความอื่น:

${step === 1 ? '{"doc_type":"prescription","date":"dd/mm/yyyy","order_no":"","hn":"","patient_name":"","rights":"","product_name":"","quantity":1,"price":"","doctor":""}' : ''}
${step === 2 ? '{"doc_type":"serial","brand":"","model":"","serial_number":"","ref":""}' : ''}
${step === 3 ? '{"doc_type":"mask","brand":"","model":"","size":"","lot":""}' : ''}`;

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

  let text = response.content[0].text.trim().replace(/```json|```/g, '').trim();
  return JSON.parse(text);
}

async function saveToSheets(session) {
  const p = session.prescription||{}, s = session.serial||{}, m = session.mask||{};
  const row = [
    p.date||'', p.hn||'', p.patient_name||'', p.rights||'',
    p.order_no||'', p.doctor||'', p.product_name||'', p.quantity||1, p.price||'',
    s.brand||'', s.model||'', s.serial_number||'',
    m.brand||'-', m.model||'-', m.size||'-',
    `Spec_${(s.model||'').substring(0,10)}`, '✅ บันทึกแล้ว', 'ระบบ Auto'
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
  await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
}

async function push(to, text) {
  await lineClient.pushMessage({ to, messages: [{ type: 'text', text }] });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`3N Bot running on port ${PORT}`));
