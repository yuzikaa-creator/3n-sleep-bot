// index.js — 3N CPAP Bot v2.1 (Fixed)
// ═══════════════════════════════════════════════════════════════
// แก้ปัญหา 429 Too Many Requests:
//   ✅ FIX 1 — Model: claude-haiku-4-5-20251001 (เดิม sonnet → คนละ rate limit!)
//   ✅ FIX 2 — Message ID dedup: ป้องกัน Line retry process รูปซ้ำ
//   ✅ FIX 3 — Per-user lock: ป้องกัน concurrent image request เดียวกัน
//   ✅ FIX 4 — Retry + backoff: Claude 429 → รอ 2s/4s/8s แล้ว retry อัตโนมัติ
//   ✅ FIX 5 — Error log ชัด: แยก Line API 429 vs Claude API 429 ใน log
// ═══════════════════════════════════════════════════════════════

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

// session: { userId: { step:1/2, prescription:{}, serial:{}, mask:{} } }
const sessions = {};

// ── FIX 2: Message ID Dedup ─────────────────────────────────────
// เก็บ message ID ที่ process แล้ว 5 นาที → กัน Line retry ซ้ำ
const processedMsgIds = new Set();
function markProcessed(msgId) {
  processedMsgIds.add(msgId);
  setTimeout(() => processedMsgIds.delete(msgId), 5 * 60 * 1000);
}

// ── FIX 3: Per-user Processing Lock ────────────────────────────
// ป้องกัน user ส่งรูปซ้อนกัน → request concurrent → rate limit
const processingLock = new Set();

// ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('3N CPAP Bot is running ✅'));

app.post('/webhook', line.middleware(LINE_CONFIG), async (req, res) => {
  res.sendStatus(200); // ตอบ Line ทันที ก่อน process
  const now = Date.now();

  for (const event of req.body.events) {
    // ข้าม event เก่าเกิน 60 วินาที
    if (event.timestamp && (now - event.timestamp > 60000)) {
      console.log(`[SKIP] Old event (${Math.round((now - event.timestamp) / 1000)}s old)`);
      continue;
    }

    // FIX 2: ข้าม message ที่ process แล้ว (Line retry)
    const msgId = event.message?.id;
    if (msgId) {
      if (processedMsgIds.has(msgId)) {
        console.log(`[SKIP] Duplicate msgId: ${msgId}`);
        continue;
      }
      markProcessed(msgId);
    }

    await handleEvent(event).catch(err =>
      console.error('[EVENT ERROR]', err.message)
    );
  }
});

// ───────────────────────────────────────────────────────────────
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
      await reply(replyToken,
        '🔲 ส่งรูป Serial เครื่องได้เลยครับ\n' +
        '(ส่งรูป Mask ต่อได้เลย ไม่ต้องพิมพ์ 3)'
      );
      return;
    }

    // ── Mask shortcode เช่น RN20L, RF20S ────────────────────────
    const upperText = text.toUpperCase().replace(/\s/g, '');
    const maskLookup = {
      'RN20S':  { brand: 'ResMed',   model: 'AirFit N20',      size: 'Small'  },
      'RN20M':  { brand: 'ResMed',   model: 'AirFit N20',      size: 'Medium' },
      'RN20L':  { brand: 'ResMed',   model: 'AirFit N20',      size: 'Large'  },
      'RN30':   { brand: 'ResMed',   model: 'AirFit N30',      size: '-'      },
      'RN30S':  { brand: 'ResMed',   model: 'AirFit N30',      size: 'Small'  },
      'RN30M':  { brand: 'ResMed',   model: 'AirFit N30',      size: 'Medium' },
      'RN30L':  { brand: 'ResMed',   model: 'AirFit N30',      size: 'Large'  },
      'RF20S':  { brand: 'ResMed',   model: 'AirFit F20',      size: 'Small'  },
      'RF20M':  { brand: 'ResMed',   model: 'AirFit F20',      size: 'Medium' },
      'RF20L':  { brand: 'ResMed',   model: 'AirFit F20',      size: 'Large'  },
      'RP10XS': { brand: 'ResMed',   model: 'AirFit P10',      size: 'XSmall' },
      'RP10S':  { brand: 'ResMed',   model: 'AirFit P10',      size: 'Small'  },
      'RP10M':  { brand: 'ResMed',   model: 'AirFit P10',      size: 'Medium' },
      'RP10L':  { brand: 'ResMed',   model: 'AirFit P10',      size: 'Large'  },
      'HNM':    { brand: 'Hingmed',  model: 'Nasal Mask',      size: 'Medium' },
      'HNL':    { brand: 'Hingmed',  model: 'Nasal Mask',      size: 'Large'  },
      'HFM':    { brand: 'Hingmed',  model: 'Full Face Mask',  size: 'Medium' },
      'HFL':    { brand: 'Hingmed',  model: 'Full Face Mask',  size: 'Large'  },
    };

    if (maskLookup[upperText]) {
      const maskData = maskLookup[upperText];
      if (!sessions[userId]) sessions[userId] = {};
      sessions[userId].mask = maskData;

      let msg = `😷 บันทึก Mask แล้ว\n` +
        `Brand: ${maskData.brand}\nModel: ${maskData.model}\nSize: ${maskData.size}`;

      const session = sessions[userId];
      if (session.prescription && session.serial) {
        const rowNum = await saveToSheets(session);
        const p = session.prescription;
        msg = `✅ บันทึกสำเร็จ! (แถว ${rowNum})\n──────────────────\n` +
          `👤 ${p.patient_name || '-'}\n🏥 HN: ${p.hn || '-'}\n` +
          `📅 ${p.date || '-'}\n💊 ${p.product_name || '-'}\n` +
          `🔲 SN: ${session.serial.serial_number || '-'}\n` +
          `😷 ${maskData.model} (${maskData.size})\n` +
          `💰 ${p.price || '-'} บาท`;
        delete sessions[userId];
      }
      await reply(replyToken, msg);
      return;
    }

    // code หน้าตาเหมือน mask แต่ไม่รู้จัก
    if (/^(RN|RF|RP|HN|HF)/i.test(upperText)) {
      await reply(replyToken,
        `⚠️ ไม่รู้จัก Mask code: ${text}\n\nตัวอย่าง:\n` +
        `RN20S/M/L, RN30\nRF20S/M/L\nRP10XS/S/M/L\nHNM, HNL, HFM, HFL`
      );
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
          `👤 ${p.patient_name || '-'}\n🏥 HN: ${p.hn || '-'}\n` +
          `📅 ${p.date || '-'}\n💊 ${p.product_name || '-'}\n` +
          `🔲 SN: ${session.serial.serial_number || '-'}\n` +
          `😷 Mask: ${session.mask ? `${session.mask.model} (${session.mask.size})` : '-'}\n` +
          `💰 ${p.price || '-'} บาท`
        );
      } else {
        await reply(replyToken, '⚠️ ข้อมูลยังไม่ครบ\nพิมพ์ 1 → ส่งใบสั่งยา\nพิมพ์ 2 → ส่ง Serial');
      }
      return;
    }

    if (text === 'ยกเลิก' || text === '0') {
      delete sessions[userId];
      await reply(replyToken, '🗑️ ล้างข้อมูลแล้ว\nพิมพ์ 1 เพื่อเริ่มใหม่');
      return;
    }

    if (text === 'สถานะ' || text === 'status') {
      const s = sessions[userId] || {};
      const has = (k) => s[k] ? '✅' : '⬜';
      await reply(replyToken,
        `📊 สถานะ:\n${has('prescription')} 1. ใบสั่งยา\n` +
        `${has('serial')} 2. Serial เครื่อง\n${has('mask')} 3. Mask\n\n` +
        `พิมพ์ "บันทึก" เมื่อพร้อม`
      );
      return;
    }

    if (text === 'help' || text === 'ช่วยเหลือ') {
      await reply(replyToken,
        `🤖 วิธีใช้ 3NEXA AI\n──────────────────\n` +
        `พิมพ์ 1 → ส่งรูปใบสั่งยา\n` +
        `พิมพ์ 2 → ส่งรูป Serial เครื่อง\n` +
        `         (แล้วส่งรูป Mask ต่อได้เลย)\n` +
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
      await push(chatId,
        `⚠️ กรุณาพิมพ์ก่อนส่งรูป:\n` +
        `พิมพ์ 1 = ส่งใบสั่งยา\nพิมพ์ 2 = ส่ง Serial เครื่อง`
      );
      return;
    }

    // FIX 3: ป้องกัน concurrent image request ของ user เดียวกัน
    if (processingLock.has(userId)) {
      await push(chatId, '⏳ กำลังประมวลผลรูปก่อนหน้า กรุณารอสักครู่...');
      return;
    }
    processingLock.add(userId);

    try {
      // ── Step 1: ดาวน์โหลดรูปจาก Line ───────────────────────
      let imageBuffer;
      try {
        imageBuffer = await downloadLineImage(message.id);
      } catch (lineErr) {
        // FIX 5: log ชัดว่า 429 มาจาก Line ไม่ใช่ Claude
        const status = lineErr.response?.status;
        console.error(`[LINE DOWNLOAD ERROR] status=${status} msg=${lineErr.message}`);
        if (status === 429) {
          await push(chatId, '⚠️ Line API limit — กรุณารอสักครู่แล้วส่งรูปใหม่');
        } else {
          await push(chatId, `❌ ดาวน์โหลดรูปไม่ได้ (Line ${status || 'ERR'})\nกรุณาส่งรูปใหม่`);
        }
        return;
      }

      // ── Step 2: เรียก Claude API (FIX 1 + FIX 4) ───────────
      let data;
      try {
        data = await extractFromImage(imageBuffer.toString('base64'), session.step);
      } catch (claudeErr) {
        // FIX 5: log ชัดว่า 429 มาจาก Claude
        const status = claudeErr.status;
        console.error(`[CLAUDE ERROR] status=${status} msg=${claudeErr.message}`);
        if (status === 429) {
          await push(chatId,
            '⚠️ Claude API limit — retry 3 ครั้งแล้วยังไม่ได้\n' +
            'กรุณารอ 30 วิแล้วส่งรูปใหม่'
          );
        } else {
          await push(chatId, `❌ อ่านรูปไม่ได้: ${claudeErr.message.substring(0, 60)}\nกรุณาส่งรูปใหม่`);
        }
        return;
      }

      // ── ประมวลผลตาม step ─────────────────────────────────────
      if (session.step === 1) {
        session.prescription = data;
        session.step = null;
        await push(chatId,
          `📄 อ่านใบสั่งยาแล้ว\n──────────────────\n` +
          `👤 ${data.patient_name || '-'}\n🏥 HN: ${data.hn || '-'}\n` +
          `🔰 สิทธิ์: ${data.rights || '-'}\n💊 ${data.product_name || '-'}\n` +
          `💰 ${data.price || '-'} บาท\n\n` +
          `⏭️ พิมพ์ 2 เพื่อส่งรูป Serial เครื่อง`
        );

      } else if (session.step === 2) {
        const docType = data.doc_type;

        if (docType === 'serial') {
          session.serial = data;
          await push(chatId,
            `🔲 อ่าน Serial แล้ว\n──────────────────\n` +
            `Brand: ${data.brand || '-'}\nModel: ${data.model || '-'}\nSN: ${data.serial_number || '-'}\n\n` +
            `ส่งรูป Mask ต่อได้เลย หรือพิมพ์ "บันทึก"`
          );

        } else if (docType === 'mask') {
          session.mask = data;
          let msg = `😷 อ่าน Mask แล้ว\n──────────────────\n` +
            `Brand: ${data.brand || '-'}\nModel: ${data.model || '-'}\nSize: ${data.size || '-'}`;

          if (session.prescription && session.serial) {
            const rowNum = await saveToSheets(session);
            const p = session.prescription;
            msg = `✅ บันทึกสำเร็จ! (แถว ${rowNum})\n──────────────────\n` +
              `👤 ${p.patient_name || '-'}\n🏥 HN: ${p.hn || '-'}\n` +
              `📅 ${p.date || '-'}\n💊 ${p.product_name || '-'}\n` +
              `🔲 SN: ${session.serial.serial_number || '-'}\n` +
              `😷 ${data.model || '-'} (${data.size || '-'})\n` +
              `💰 ${p.price || '-'} บาท`;
            delete sessions[userId];
          }
          await push(chatId, msg);

        } else {
          await push(chatId, `⚠️ ระบุประเภทรูปไม่ได้ กรุณาส่งรูปใหม่`);
        }
      }

    } finally {
      processingLock.delete(userId); // FIX 3: unlock เสมอ แม้ error
    }
  }
}

// ── FIX 1 + FIX 4: Claude Haiku + Retry with Exponential Backoff ──
async function extractFromImage(base64, step, maxRetries = 3) {
  const typeHint = step === 1
    ? 'ใบสั่งยา/ใบรายการยาของโรงพยาบาล'
    : 'ป้าย Serial Number ของเครื่อง CPAP/BiPAP หรือซองหน้ากาก CPAP Mask';

  const jsonTemplate = step === 1
    ? '{"doc_type":"prescription","date":"dd/mm/yyyy","order_no":"","hn":"","patient_name":"","rights":"","product_name":"","quantity":1,"price":"","doctor":""}'
    : 'ถ้า Serial: {"doc_type":"serial","brand":"","model":"","serial_number":"","ref":""}\nถ้า Mask: {"doc_type":"mask","brand":"","model":"","size":"","lot":""}';

  const prompt =
    `คุณคือระบบอ่านเอกสาร CPAP ของ 3N Co., Ltd.\n` +
    `รูปนี้คือ: ${typeHint}\n` +
    `ตอบเป็น JSON เท่านั้น ไม่มีข้อความอื่น:\n${jsonTemplate}`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[CLAUDE] Attempt ${attempt}/${maxRetries} — step=${step}`);

      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',  // ✅ FIX 1: เดิม claude-sonnet-4-6
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
            { type: 'text', text: prompt }
          ]
        }]
      });

      const raw = response.content[0].text.trim().replace(/```json|```/g, '').trim();
      console.log(`[CLAUDE] OK attempt=${attempt} raw=${raw.substring(0, 80)}`);
      return JSON.parse(raw);

    } catch (err) {
      console.error(`[CLAUDE] Attempt ${attempt} FAILED status=${err.status} msg=${err.message}`);

      // FIX 4: retry เฉพาะ 429 และยังมี attempt เหลือ
      if (err.status === 429 && attempt < maxRetries) {
        const waitMs = Math.pow(2, attempt) * 1000; // 2s → 4s → 8s
        console.log(`[CLAUDE] 429 — waiting ${waitMs}ms before retry...`);
        await new Promise(r => setTimeout(r, waitMs));
      } else {
        throw err; // 4xx อื่น หรือ retry หมดแล้ว → throw ออก
      }
    }
  }
}

// ── Google Sheets ────────────────────────────────────────────────
async function saveToSheets(session) {
  const p = session.prescription || {}, s = session.serial || {}, m = session.mask || {};
  const row = [
    p.date || '', p.hn || '', p.patient_name || '', p.rights || '',
    p.order_no || '', p.doctor || '', p.product_name || '', p.quantity || 1, p.price || '',
    s.brand || '', s.model || '', s.serial_number || '',
    m.brand || '-', m.model || '-', m.size || '-',
    `Spec_${(s.model || '').substring(0, 10)}`, '✅ บันทึกแล้ว', 'ระบบ Auto'
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

// ── Line Helpers ─────────────────────────────────────────────────
async function downloadLineImage(messageId) {
  const response = await axios.get(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
      responseType: 'arraybuffer'
    }
  );
  return Buffer.from(response.data);
}

async function reply(replyToken, text) {
  await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
}

async function push(to, text) {
  await lineClient.pushMessage({ to, messages: [{ type: 'text', text }] });
}

// ── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`3N Bot v2.1 running on port ${PORT}`));
