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
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive'
  ]
});
const sheets = google.sheets({ version: 'v4', auth });
const drive = google.drive({ version: 'v3', auth });

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

  // ============ รับรูป OPD ============
  if (message.type === 'image') {
    try {
      // ดาวน์โหลดรูป
      const imageBuffer = await downloadLineImage(message.id);
      const base64Image = imageBuffer.toString('base64');

      // อ่านข้อมูลด้วย Claude
      const patientData = await extractOPDData(base64Image);
      if (!patientData) return;

      // อัปโหลดรูปขึ้น Google Drive
      const driveUrl = await uploadToDrive(imageBuffer, `OPD_${patientData.ชื่อนามสกุล || 'unknown'}_${Date.now()}.jpg`);

      // บันทึกลง Sheets พร้อมลิงก์รูป
      await saveToSheets(patientData, driveUrl);

      // Reply สรุปสั้นๆ
      await lineClient.replyMessage({
        replyToken,
        messages: [{
          type: 'text',
          text: `✅ บันทึกแล้วครับ\n\n` +
                `👤 ${patientData.ชื่อนามสกุล || '-'}\n` +
                `📞 ${patientData.เบอร์โทรหลัก || '-'}\n` +
                `🏥 HN: ${patientData.HN || '-'}\n` +
                `🔬 ${patientData.ประเภทการตรวจ || '-'}\n\n` +
                `⚠️ ทีมสามเอ็นจะตรวจสอบและโทรนัดครับ`
        }]
      });

    } catch (err) {
      console.error('Error:', err.message);
    }
    return;
  }

  // ============ @3N ============
  if (message.type === 'text') {
    const text = message.text;
    if (!text.includes('@3N') && !text.includes('@3n')) return;
    await lineClient.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: `สวัสดีครับ 🤖 3N Bot\nส่งรูป OPD มาได้เลยครับ บันทึกอัตโนมัติเลย` }]
    });
  }
}

async function uploadToDrive(imageBuffer, filename) {
  const { Readable } = require('stream');
  const stream = new Readable();
  stream.push(imageBuffer);
  stream.push(null);

  const response = await drive.files.create({
    requestBody: {
      name: filename,
      mimeType: 'image/jpeg',
      parents: ['1Kwsm3J5mfpMbjK3r_mqsVor8GcGlcA-W']
    },
    media: {
      mimeType: 'image/jpeg',
      body: stream
    },
    fields: 'id, webViewLink'
  });

  // เปิดสิทธิ์ให้ดูได้
  await drive.permissions.create({
    fileId: response.data.id,
    requestBody: {
      role: 'reader',
      type: 'anyone'
    }
  });

  return response.data.webViewLink;
}

async function saveToSheets(data, driveUrl) {
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
    '⚠️ รอตรวจสอบ',
    driveUrl || ''
  ];

  // เช็ค header
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
        values: [['วันที่รับ','ชื่อ-นามสกุล','HN','เบอร์โทรหลัก','เบอร์โทรสำรอง','อายุ','น้ำหนัก (กก.)','ส่วนสูง (ซม.)','ประเภทการตรวจ','โรคประจำตัว','ยาที่ใช้','คะแนน ESS','แพทย์ผู้ส่ง','แผนก','โรงพยาบาล','สถานะ','รูป OPD']]
      }
    });
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Sheet1!A:Q',
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
