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

app.get('/', (req, res) => res.send('3N CPAP Bot is running ✅'));

app.post('/webhook', line.middleware(LINE_CONFIG), async (req, res) => {
  res.sendStatus(200);
  const now = Date.now();
  for (const event of req.body.events) {
    // ข้าม event เก่าเกิน 60 วินาที (กัน Line retry รูปค้าง → 429)
    if (event.timestamp && (now - event.timestamp > 60000)) {
      console.log(`Skipped old event (${Math.round((now-event.timestamp)/1000)}s old)`);
      continue;
    }
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
      await reply(replyToken,
        '🔲 ส่งรูป Serial เครื่องได้เลยครับ\n' +
        '(ส่งรูป Mask ต่อได้เลย ไม่ต้องพิมพ์ 3)'
      );
      return;
    }

    // ── Mask shortcode เช่น RN20L, RN30M, RF06L ─────────────────
    const upperText = text.toUpperCase().replace(/\s/g,'');
    const validCodes = ['RN20S','RN20M','RN20L','RN30','RN30S','RN30M','RN30L',
      'RF20S','RF20M','RF20L','RP10XS','RP10S','RP10M','RP10L',
      'HNM','HNL','HFM','HFL'];
    const maskCode = validCodes.includes(upperText);
    if (maskCode) {
      const [brand, type, model, size] = [upperText, upperText, upperText, upperText];
      const maskLookup = {
        // ResMed AirFit N20
        'RN20S': { brand:'ResMed', model:'AirFit N20', size:'Small'  },
        'RN20M': { brand:'ResMed', model:'AirFit N20', size:'Medium' },
        'RN20L': { brand:'ResMed', model:'AirFit N20', size:'Large'  },
        // ResMed AirFit N30
        'RN30':  { brand:'ResMed', model:'AirFit N30', size:'-'      },
        'RN30S': { brand:'ResMed', model:'AirFit N30', size:'Small'  },
        'RN30M': { brand:'ResMed', model:'AirFit N30', size:'Medium' },
        'RN30L': { brand:'ResMed', model:'AirFit N30', size:'Large'  },
        // ResMed AirFit F20 (Full Face)
        'RF20S': { brand:'ResMed', model:'AirFit F20', size:'Small'  },
        'RF20M': { brand:'ResMed', model:'AirFit F20', size:'Medium' },
        'RF20L': { brand:'ResMed', model:'AirFit F20', size:'Large'  },
        // ResMed AirFit P10 (Nasal Pillow)
        'RP10XS':{ brand:'ResMed', model:'AirFit P10', size:'XSmall' },
        'RP10S': { brand:'ResMed', model:'AirFit P10', size:'Small'  },
        'RP10M': { brand:'ResMed', model:'AirFit P10', size:'Medium' },
        'RP10L': { brand:'ResMed', model:'AirFit P10', size:'Large'  },
        // Hingmed Nasal Mask
        'HNM':   { brand:'Hingmed', model:'Nasal Mask', size:'Medium' },
        'HNL':   { brand:'Hingmed', model:'Nasal Mask', size:'Large'  },
        // Hingmed Full Face Mask
        'HFM':   { brand:'Hingmed', model:'Full Face Mask', size:'Medium' },
        'HFL':   { brand:'Hingmed', model:'Full Face Mask', size:'Large'  },
      };
      const key = upperText;
      const maskData = maskLookup[key] || null;
      if (!maskData) {
        await reply(replyToken,
          `⚠️ ไม่รู้จัก Mask code: ${text}

ตัวอย่าง:
RN20L, RN20M, RN20S
RN30
RF20S, RF20M, RF20L
RP10XS, RP10S, RP10M, RP10L
HNL, HNM, HFL, HFM`
        );
        return;
      }

      if (!sessions[userId]) sessions[userId] = {};
      sessions[userId].mask = maskData;

      let msg = `😷 บันทึก Mask แล้ว\n` +
        `Brand: ${maskData.brand}\nModel: ${maskData.model}\nSize: ${maskData.size}`;

      // ถ้าครบ → บันทึก Sheet
      const session = sessions[userId];
      if (session.prescription && session.serial) {
        const rowNum = await saveToSheets(session);
        const p = session.prescription;
        msg = `✅ บันทึกสำเร็จ! (แถว ${rowNum})\n──────────────────\n` +
          `👤 ${p.patient_name||'-'}\n🏥 HN: ${p.hn||'-'}\n` +
          `📅 ${p.date||'-'}\n💊 ${p.product_name||'-'}\n` +
          `🔲 SN: ${session.serial.serial_number||'-'}\n` +
          `😷 ${maskData.model} (${maskData.size})\n` +
          `💰 ${p.price||'-'} บาท`;
        delete sessions[userId];
      }
      await reply(replyToken, msg);
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
          `😷 Mask: ${session.mask?`${session.mask.model} (${session.mask.size})`:'-'}\n` +
          `💰 ${p.price||'-'} บาท`
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
        `พิมพ์ 1 = ส่งใบสั่งยา\n` +
        `พิมพ์ 2 = ส่ง Serial เครื่อง`
      );
      return;
    }

    try {
      const imageBuffer = await downloadLineImage(message.id);
      const base64 = imageBuffer.toString('base64');

      if (session.step === 1) {
        // อ่านใบสั่งยา
        const data = await extractFromImage(base64, 1);
        session.prescription = data;
        session.step = null;
        await push(chatId,
          `📄 อ่านใบสั่งยาแล้ว\n──────────────────\n` +
          `👤 ${data.patient_name||'-'}\n🏥 HN: ${data.hn||'-'}\n` +
          `🔰 สิทธิ์: ${data.rights||'-'}\n💊 ${data.product_name||'-'}\n` +
          `💰 ${data.price||'-'} บาท\n\n` +
          `⏭️ พิมพ์ 2 เพื่อส่งรูป Serial เครื่อง`
        );

      } else if (session.step === 2) {
        // อ่านรูป — อาจเป็น Serial หรือ Mask ก็ได้
        const data = await extractFromImage(base64, 2);
        const docType = data.doc_type;

        if (docType === 'serial') {
          session.serial = data;
          // ไม่ reset step — รอ Mask ต่อได้เลย
          let msg = `🔲 อ่าน Serial แล้ว\n──────────────────\n` +
            `Brand: ${data.brand||'-'}\nModel: ${data.model||'-'}\nSN: ${data.serial_number||'-'}\n\n` +
            `ส่งรูป Mask ต่อได้เลย หรือพิมพ์ "บันทึก"`;
          await push(chatId, msg);

        } else if (docType === 'mask') {
          session.mask = data;
          let msg = `😷 อ่าน Mask แล้ว\n──────────────────\n` +
            `Brand: ${data.brand||'-'}\nModel: ${data.model||'-'}\nSize: ${data.size||'-'}`;

          // ถ้าครบ → บันทึกเลย
          if (session.prescription && session.serial) {
            const rowNum = await saveToSheets(session);
            const p = session.prescription;
            msg = `✅ บันทึกสำเร็จ! (แถว ${rowNum})\n──────────────────\n` +
              `👤 ${p.patient_name||'-'}\n🏥 HN: ${p.hn||'-'}\n` +
              `📅 ${p.date||'-'}\n💊 ${p.product_name||'-'}\n` +
              `🔲 SN: ${session.serial.serial_number||'-'}\n` +
              `😷 ${data.model||'-'} (${data.size||'-'})\n` +
              `💰 ${p.price||'-'} บาท`;
            delete sessions[userId];
          }
          await push(chatId, msg);

        } else {
          await push(chatId, `⚠️ ระบุประเภทไม่ได้ กรุณาส่งรูปใหม่`);
        }
      }

    } catch (err) {
      console.error('Image error:', err.message);
      await push(chatId, `❌ อ่านรูปไม่ได้: ${err.message.substring(0,60)}\nกรุณาส่งรูปใหม่`);
    }
  }
}

async function extractFromImage(base64, step) {
  const typeHint = step === 1
    ? 'ใบสั่งยา/ใบรายการยาของโรงพยาบาลราชพิพัฒน์'
    : 'ป้าย Serial Number ของเครื่อง CPAP/BiPAP หรือซองหน้ากาก CPAP Mask';

  const jsonTemplate = step === 1
    ? '{"doc_type":"prescription","date":"dd/mm/yyyy","order_no":"","hn":"","patient_name":"","rights":"","product_name":"","quantity":1,"price":"","doctor":""}'
    : 'ถ้า Serial: {"doc_type":"serial","brand":"","model":"","serial_number":"","ref":""}\nถ้า Mask: {"doc_type":"mask","brand":"","model":"","size":"","lot":""}';

  const prompt = `คุณคือระบบอ่านเอกสาร CPAP ของ 3N Co., Ltd.
รูปนี้คือ: ${typeHint}
ตอบเป็น JSON เท่านั้น ไม่มีข้อความอื่น:
${jsonTemplate}`;

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
