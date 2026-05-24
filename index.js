const express = require('express');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const admin = require('firebase-admin');
const axios = require('axios');

const LINE_CONFIG = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: process.env.FIREBASE_PROJECT_ID || 'n-sleep-app'
});
const db = admin.firestore();

const app = express();
const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CONFIG.channelAccessToken
});

app.get('/', (req, res) => res.send('3N Sleep Bot is running ✅'));

app.post('/webhook', line.middleware(LINE_CONFIG), async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events;
  for (const event of events) {
    await handleEvent(event);
  }
});

async function handleEvent(event) {
  if (event.type !== 'message') return;
  const { replyToken, source, message } = event;
  const groupId = source.groupId || source.userId;
  const userId = source.userId;

  if (message.type === 'image') {
    try {
      const imageBuffer = await downloadLineImage(message.id);
      const base64Image = imageBuffer.toString('base64');
      const patientData = await extractOPDData(base64Image);
      if (!patientData) return;

      const docRef = await db.collection('cases').add({
        ...patientData,
        hospital: 'รพ.ราษฎร์บูรณะ',
        status: 'รอโทรนัด',
        groupId, userId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      await lineClient.replyMessage({
        replyToken,
        messages: [{
          type: 'text',
          text: `✅ บันทึก case แล้วครับ\n\n` +
                `👤 ชื่อ: ${patientData.name || '-'}\n` +
                `📞 เบอร์: ${patientData.phone || '-'}\n` +
                `🏥 HN: ${patientData.hn || '-'}\n` +
                `🔬 ตรวจ: ${patientData.testType || '-'}\n` +
                `💊 โรคประจำตัว: ${patientData.disease || '-'}\n\n` +
                `สามเอ็นจะโทรนัดภายใน 24 ชม. ครับ`
        }]
      });
    } catch (err) {
      console.error('Image error:', err);
    }
    return;
  }

  if (message.type === 'text') {
    const text = message.text;
    if (!text.includes('@3N') && !text.includes('@3n')) return;

    const query = text.replace(/@3[Nn]/g, '').trim();
    if (query.includes('วันนี้') || query.includes('case') || query.includes('สรุป')) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const snapshot = await db.collection('cases').where('createdAt', '>=', today).get();
      const total = snapshot.size;
      const waiting = snapshot.docs.filter(d => d.data().status === 'รอโทรนัด').length;
      await lineClient.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: `📊 สรุป case วันนี้\nทั้งหมด: ${total} case\nรอโทรนัด: ${waiting} case` }]
      });
      return;
    }

    await lineClient.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: `สวัสดีครับ 🤖 3N Bot\nส่งรูป OPD มาได้เลยครับ\n\nคำสั่ง: @3N วันนี้` }]
    });
  }
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
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
        { type: 'text', text: `อ่าน OPD record แล้วดึงข้อมูล ตอบเป็น JSON เท่านั้น:\n{"name":"","phone":"","hn":"","testType":"","disease":"","medication":"","doctor":"","ess":""}\nถ้าไม่ใช่ OPD record ตอบว่า NOT_OPD` }
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
