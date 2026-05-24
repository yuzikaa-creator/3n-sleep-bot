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

// Google Sheets Auth
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

app.get('/', (req, res) => res.send('3N Sleep Bot is running ✅'));

app.post('/webhook', line.middleware(LINE_CONFIG), async (req, res) => {
  res.sendStatus(200);
  for (const event of req.body.events) {
    await handleEvent(event);
  }
});

async function handleEvent(event) {
  if (event.type !== 'message') return;
  const { replyToken, message } = event;

  if (message.type === 'image') {
    try {
      const imageBuffer = await downloadLineImage(message.id);
      const base64Image = imageBuffer.toString('base64');
      const patientData = await extractOPDData(base64Image);
      if (!patientData) return;

      // บันทึกลง Google Sheets
      await saveToSheets(patientData);

      await lineClient.replyMessage({
        replyToken,
        messages: [{
          type: 'text',
          text: `✅ บันทึก case แล้วครับ\n\n` +
                `👤 ชื่อ: ${patientData.ชื่อนามสกุล || '-'}\n` +
                `📞 เบอร์หลัก: ${patientData.เบอร์โทรหลัก || '-'}\n` +
                `📞 เบอร์สำรอง: ${patientData.เบอร์โทรสำรอง || '-'}\n` +
                `🏥 HN: ${patientData.HN || '-'}\n` +
                `🔬 ตรวจ: ${patientData.ประเภทการตรวจ || '-'}\n` +
                `💊 โรคประจำตัว: ${patientData.โรคประจำตัว || '-'}\n` +
                `💊 ยาที่ใช้: ${patientData.ยาที่ใช้ || '-'}\n` +
                `📊 ESS: ${patientData.คะแนนESS || '-'}\n` +
                `👨‍⚕️ แพทย์: ${patientData.แพทย์ผู้ส่ง || '-'}\n\n` +
                `บันทึกลง Google Sheets แล้วครับ 📋`
        }]
      });
    } catch (err) {
      console.error('Image error:', err.message);
    }
    return;
  }

  if (message.type === 'text') {
    const text = message.text;
    if (!text.includes('@3N') && !text.includes('@3n')) return;
    await lineClient.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: `สวัสดีครับ 🤖 3N Bot\nส่งรูป OPD มาได้เลยครับ จะบันทึกลง Google Sheets อัตโนมัติ` }]
    });
  }
}

async function saveToSheets(data) {
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
    'รอโทรนัด'
  ];

  // เพิ่ม header ถ้ายังไม่มี
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
        { type: 'text', text: `อ่าน OPD record แล้วดึงข้อมูลต่อไปนี้เป็นภาษาไทย ตอบเป็น JSON เท่านั้น ไม่มีคำอธิบาย:
{"ชื่อนามสกุล":"","HN":"","เบอร์โทรหลัก":"","เบอร์โทรสำรอง":"","อายุ":"","น้ำหนัก":"","ส่วนสูง":"","ประเภทการตรวจ":"","โรคประจำตัว":"","ยาที่ใช้":"","คะแนนESS":"","แพทย์ผู้ส่ง":"","แผนก":""}
ถ้าไม่ใช่ OPD record ตอบว่า NOT_OPD` }
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
