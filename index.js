const express = require('express');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const admin = require('firebase-admin');

// ==================== CONFIG (ดึงจาก Environment Variables) ====================
const LINE_CONFIG = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const anthropic = new Anthropic({ 
  apiKey: process.env.CLAUDE_API_KEY 
});

// Firebase Admin init
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: process.env.FIREBASE_PROJECT_ID || 'n-sleep-app'
});
const db = admin.firestore();

// ==================== INIT ====================
const app = express();
const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CONFIG.channelAccessToken
});

// ==================== WEBHOOK ====================
app.post('/webhook', line.middleware(LINE_CONFIG), async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events;
  for (const event of events) {
    await handleEvent(event);
  }
});

app.get('/', (req, res) => res.send('3N Sleep Bot is running ✅'));

async function handleEvent(event) {
  if (event.type !== 'message') return;

  const { replyToken, source, message } = event;
  const groupId = source.groupId || source.userId;
  const userId = source.userId;

  // ============ กรณีส่งรูปมา ============
  if (message.type === 'image') {
    try {
      const imageBuffer = await downloadLineImage(message.id);
      const base64Image = imageBuffer.toString('base64');
      const patientData = await extractOPDData(base64Image);

      if (!patientData) return; // ไม่ใช่ OPD ไม่ตอบ

      const docRef = await db.collection('cases').add({
        ...patientData,
        hospital: 'รพ.ราษฎร์บูรณะ',
        status: 'รอโทรนัด',
        groupId,
        userId,
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
                `📋 Case ID: ${docRef.id.slice(0,8)}\n` +
                `สามเอ็นจะโทรนัดภายใน 24 ชม. ครับ`
        }]
      });

    } catch (err) {
      console.error('Image error:', err);
    }
    return;
  }

  // ============ กรณีพิมพ์ @3N ============
  if (message.type === 'text') {
    const text = message.text;
    if (!text.includes('@3N') && !text.includes('@3n')) return;

    const query = text.replace(/@3[Nn]/g, '').trim();

    if (query.includes('วันนี้') || query.includes('case') || query.includes('สรุป')) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const snapshot = await db.collection('cases')
        .where('createdAt', '>=', today)
        .get();

      const total = snapshot.size;
      const waiting = snapshot.docs.filter(d => d.data().status === 'รอโทรนัด').length;

      await lineClient.replyMessage({
        replyToken,
        messages: [{
          type: 'text',
          text: `📊 สรุป case วันนี้\n` +
                `ทั้งหมด: ${total} case\n` +
                `รอโทรนัด: ${waiting} case\n` +
                `ยืนยันแล้ว: ${total - waiting} case`
        }]
      });
      return;
    }

    await lineClient.replyMessage({
      replyToken,
      messages: [{
        type: 'text',
        text: `สวัสดีครับ 🤖 3N Bot\nส่งรูป OPD มาได้เลย Bot จะอ่านข้อมูลให้อัตโนมัติครับ\n\nคำสั่ง:\n@3N วันนี้ — ดู case วันนี้`
      }]
    });
  }
}

// ==================== HELPERS ====================
async function downloadLineImage(messageId) {
  const stream = await lineClient.getMessageContent(messageId);
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function extractOPDData(base64Image) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: base64Image }
        },
        {
          type: 'text',
          text: `นี่คือรูป OPD record จากโรงพยาบาล กรุณาอ่านและดึงข้อมูลต่อไปนี้:
- ชื่อ-นามสกุล (name)
- เบอร์โทร (phone)
- HN (hn)
- ประเภทการตรวจ เช่น PSG, HST, CPAP Titration (testType)
- โรคประจำตัว (disease)
- ยาที่ใช้ (medication)
- แพทย์ผู้ส่ง (doctor)
- ESS score (ess)

ถ้าไม่ใช่ OPD record ให้ตอบว่า NOT_OPD

ตอบเป็น JSON เท่านั้น ไม่ต้องมีคำอธิบาย เช่น:
{"name":"นาย สมชาย ใจดี","phone":"081-234-5678","hn":"12345","testType":"PSG Full-Night","disease":"HT","medication":"Amlodipine","doctor":"นพ.สมศักดิ์","ess":"14/24"}`
        }
      ]
    }]
  });

  const text = response.content[0].text.trim();
  if (text === 'NOT_OPD' || text.includes('NOT_OPD')) return null;

  try {
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

// ==================== START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`3N Bot running on port ${PORT}`));
