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

const pendingCases = {};

app.get('/', (req, res) => res.send('3N Sleep Bot is running ✅'));

app.post('/webhook', line.middleware(LINE_CONFIG), async (req, res) => {
  res.sendStatus(200);
  for (const event of req.body.events) {
    await handleEvent(event);
  }
});

async function handleEvent(event) {
  if (event.type !== 'message') return;
  const { replyToken, source, message } = event;
  const userId = source.userId;

  if (message.type === 'image') {
    try {
      const imageBuffer = await downloadLineImage(message.id);
      const base64Image = imageBuffer.toString('base64');
      const patientData = await extractOPDData(base64Image);
      if (!patientData) return;

      pendingCases[userId] = patientData;

      await lineClient.replyMessage({
        replyToken,
        messages: [{
          type: 'template',
          altText: 'ยืนยันข้อมูลคนไข้',
          template: {
            type: 'buttons',
            text: `📋 ตรวจสอบข้อมูลด้วยนะครับ\n` +
                  `👤 ชื่อ: ${patientData.ชื่อนามสกุล || '-'}\n` +
                  `📞 เบอร์: ${patientData.เบอร์โทรหลัก || '-'}\n` +
                  `🏥 HN: ${patientData.HN || '-'}\n` +
                  `🔬 ตรวจ: ${patientData.ประเภทการตรวจ || '-'}\n` +
                  `💊 โรค: ${patientData.โรคประจำตัว || '-'}\n` +
                  `📊 ESS: ${patientData.คะแนนESS || '-'}`,
            actions: [
              { type: 'message', label: '✅ ถูกต้อง บันทึกเลย', text: 'ยืนยัน_บันทึก' },
              { type: 'message', label: '✏️ รบกวน 3N ช่วยแก้', text: 'ขอให้3Nแก้ไข' },
              { type: 'message', label: '❌ ยกเลิก ส่งรูปใหม่', text: 'ยกเลิก_แก้ไข' }
            ]
          }
        }]
      });
    } catch (err) {
      console.error('Image error:', err.message);
    }
    return;
  }

  if (message.type === 'text') {
    const text = message.text;

    // ยืนยันถูกต้อง
    if (text === 'ยืนยัน_บันทึก') {
      const patientData = pendingCases[userId];
      if (!patientData) {
        await lineClient.replyMessage({
          replyToken,
          messages: [{ type: 'text', text: 'ไม่พบข้อมูลที่รอบันทึกครับ กรุณาส่งรูป OPD ใหม่อีกครั้ง' }]
        });
        return;
      }
      try {
        await saveToSheets(patientData, 'รอโทรนัด');
        delete pendingCases[userId];
        await lineClient.replyMessage({
          replyToken,
          messages: [{ type: 'text', text: `✅ บันทึกลง Google Sheets แล้วครับ!\n\n👤 ${patientData.ชื่อนามสกุล || '-'}\n📞 ${patientData.เบอร์โทรหลัก || '-'}\n🏥 HN: ${patientData.HN || '-'}\n\nสามเอ็นจะโทรนัดภายใน 24 ชม. ครับ 🙏` }]
        });
      } catch (err) {
        console.error('Sheets error:', err.message);
      }
      return;
    }

    // ขอให้ 3N แก้ไข
    if (text === 'ขอให้3Nแก้ไข') {
      const patientData = pendingCases[userId];
      if (!patientData) {
        await lineClient.replyMessage({
          replyToken,
          messages: [{ type: 'text', text: 'ไม่พบข้อมูลที่รอบันทึกครับ กรุณาส่งรูป OPD ใหม่อีกครั้ง' }]
        });
        return;
      }
      try {
        await saveToSheets(patientData, '⚠️ รอสามเอ็นตรวจสอบ');
        delete pendingCases[userId];
        await lineClient.replyMessage({
          replyToken,
          messages: [{ type: 'text', text: `📝 บันทึกแล้วครับ ทีมสามเอ็นจะตรวจสอบและแก้ไขให้นะครับ\n\n👤 ${patientData.ชื่อนามสกุล || '-'}\n📞 ${patientData.เบอร์โทรหลัก || '-'}\n🏥 HN: ${patientData.HN || '-'} 🙏` }]
        });
      } catch (err) {
        console.error('Sheets error:', err.message);
      }
      return;
    }

    // ยกเลิก
    if (text === 'ยกเลิก_แก้ไข') {
      delete pendingCases[userId];
      await lineClient.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: 'ยกเลิกแล้วครับ กรุณาส่งรูป OPD ใหม่อีกครั้งครับ 🙏' }]
      });
      return;
    }

    // @3N
    if (text.includes('@3N') || text.includes('@3n')) {
      await lineClient.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: `สวัสดีครับ 🤖 3N Bot\nส่งรูป OPD มาได้เลยครับ` }]
      });
    }
  }
}

async function saveToSheets(data, status) {
  const now = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  const row = [
    now,
    data.ชื่อนามสกุล || '',
    data.HN || '',
    data.เบอร์โทรหลัก || '',
    data.เบอร์โทรสำรอง || '',
    data.อายุ || '',
    data.น้ำหนัก || '',
    data.ส่วนสูง || '',
    data.ประเภทการตรวจ || '',
    data.โรคประจำตัว || '',
    data.ยาที่ใช้ || '',
    data.คะแนนESS || '',
    data.แพทย์ผู้ส่ง || '',
    data.แผนก || '',
    'รพ.ราษฎร์บูรณะ',
    status
  ];

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Sheet1!A1'
  });

  if (!response.data.values) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!A1',
      valueInputOption: 'RAW',
      requestBody: {
        values: [['วันที่รับ','ชื่อ-นามสกุล','HN','เบอร์โทรหลัก','เบอร์โทรสำรอง','อายุ','น้ำหนัก (กก.)','ส่วนสูง (ซม.)','ประเภทการตรวจ','โรคประจำตัว','ยาที่ใช้','คะแนน ESS','แพทย์ผู้ส่ง','แผนก','โรงพยาบาล','สถานะ']]
      }
    });
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Sheet1!A:P',
    valueInputOption: 'RAW',
    requestBody: { values: [row] }
  });
}

async function downloadLineImage(messageId) {
  const response = await axios.get(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      headers: { Authorization: `Bearer ${LINE_CONFIG.channelAccessToken}` },
      responseType: 'arraybuffer'
    }
  );
  return Buffer.from(response.data);
}

async function extractOPDData(base64Image) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
        { type: 'text', text: `อ่าน OPD record แล้วดึงข้อมูลต่อไปนี้ให้ละเอียดที่สุด ตอบเป็น JSON เท่านั้น ไม่มีคำอธิบาย:\n{"ชื่อนามสกุล":"","HN":"","เบอร์โทรหลัก":"","เบอร์โทรสำรอง":"","อายุ":"","น้ำหนัก":"","ส่วนสูง":"","ประเภทการตรวจ":"","โรคประจำตัว":"","ยาที่ใช้":"","คะแนนESS":"","แพทย์ผู้ส่ง":"","แผนก":""}\nถ้าไม่ใช่ OPD record ตอบว่า NOT_OPD` }
      ]
    }]
  });
  const text = response.content[0].text.trim();
  if (text.includes('NOT_OPD')) return null;
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch { return null; }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`3N Bot running on port ${PORT}`));
