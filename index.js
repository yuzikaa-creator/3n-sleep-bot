const express = require('express');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const LINE_CONFIG = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

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

  // รับรูป OPD
  if (message.type === 'image') {
    try {
      const imageBuffer = await downloadLineImage(message.id);
      const base64Image = imageBuffer.toString('base64');
      const patientData = await extractOPDData(base64Image);

      if (!patientData) return; // ไม่ใช่ OPD ไม่ตอบ

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
      console.error('Image error:', err.message);
    }
    return;
  }

  // รับ @3N
  if (message.type === 'text') {
    const text = message.text;
    if (!text.includes('@3N') && !text.includes('@3n')) return;
    await lineClient.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: `สวัสดีครับ 🤖 3N Bot\nส่งรูป OPD มาได้เลยครับ` }]
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
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
        { type: 'text', text: `อ่าน OPD record แล้วดึงข้อมูล ตอบเป็น JSON เท่านั้น ไม่มีคำอธิบาย:\n{"name":"","phone":"","hn":"","testType":"","disease":"","medication":"","doctor":""}\nถ้าไม่ใช่ OPD record ตอบว่า NOT_OPD` }
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
