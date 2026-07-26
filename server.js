import Fastify from "fastify";
import fastifyFormBody from "@fastify/formbody";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const PORT = process.env.PORT || 8080;
const BASE_URL = process.env.DOMAIN 
  ? `https://${process.env.DOMAIN.replace(/^https?:\/\//, '')}`
  : `http://localhost:${PORT}`;
const LLM_MODEL = process.env.LLM_MODEL || "deepseek/deepseek-v4-flash";
const LOG_FILE = "/tmp/relay_debug.log";

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_AUTH = TWILIO_SID && TWILIO_TOKEN
  ? Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64")
  : null;

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
  console.log(...args);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

const SYSTEM_PROMPT = `你是法院通知中心的小云。永远用中文回复，每次只说1-2句话并以问题结尾。`;

const sessions = new Map();

function escapeXml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}

async function getAIResponse(conv) {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...conv.slice(-10)];
  const r = await openai.chat.completions.create({ model: LLM_MODEL, messages, temperature: 0.6, max_tokens: 120 });
  return r.choices[0].message.content.trim();
}

// ElevenLabs 语音转文字
async function transcribeAudio(audioUrl) {
  log(`⬇️ 下载录音: ${audioUrl}`);

  // 从 Twilio 下载录音
  const resp = await fetch(audioUrl, {
    headers: { "Authorization": `Basic ${TWILIO_AUTH}` }
  });
  if (!resp.ok) throw new Error(`下载失败: ${resp.status}`);
  const audioBuffer = Buffer.from(await resp.arrayBuffer());
  log(`📦 录音大小: ${audioBuffer.length} bytes`);

  // ElevenLabs STT
  const formData = new FormData();
  const blob = new Blob([audioBuffer], { type: "audio/wav" });
  formData.append("file", blob, "recording.wav");
  formData.append("model_id", "scribe_v1");
  formData.append("language", "zh");

  const sttResp = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": ELEVENLABS_KEY },
    body: formData,
  });

  if (!sttResp.ok) {
    const errText = await sttResp.text();
    throw new Error(`ElevenLabs STT 失败: ${sttResp.status} ${errText}`);
  }

  const result = await sttResp.json();
  const text = result.text || "";
  log(`📝 转写结果: "${text}"`);
  return text;
}

const fastify = Fastify({ logger: false });
fastify.register(fastifyFormBody);

fastify.get("/health", async (req, reply) => reply.send({ ok: true }));

// 接听电话
fastify.all("/voice", async (req, reply) => {
  const cs = req.body?.CallSid || "?";
  log(`📞 来电: ${cs}`);
  sessions.set(cs, []);

  reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Zhiyu" language="zh-CN">您好，这里是法院通知中心，我是小云。</Say>
  <Say voice="Polly.Zhiyu" language="zh-CN">请问您是张伟先生吗？请说话回答。</Say>
  <Record
    action="${BASE_URL}/transcribe"
    method="POST"
    maxLength="8"
    timeout="5"
    playBeep="true"
    transcribe="false" />
  <Redirect>${BASE_URL}/voice</Redirect>
</Response>`);
});

// 处理录音
fastify.all("/transcribe", async (req, reply) => {
  const cs = req.body?.CallSid;
  const recordingUrl = req.body?.RecordingUrl;

  log(`📨 录音回调(${cs}): ${recordingUrl}`);

  if (!recordingUrl) {
    return reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Zhiyu" language="zh-CN">没有听到您说话，请回答。</Say>
  <Redirect>${BASE_URL}/voice</Redirect>
</Response>`);
  }

  try {
    // 1. ElevenLabs 语音转文字
    const transcript = await transcribeAudio(recordingUrl);

    if (!transcript || transcript.trim().length === 0) {
      return reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Zhiyu" language="zh-CN">没听清楚，请再说一遍。</Say>
  <Redirect>${BASE_URL}/voice</Redirect>
</Response>`);
    }

    // 2. 保存对话
    const conv = sessions.get(cs) || [];
    conv.push({ role: "user", content: transcript });

    // 3. DeepSeek 回复
    const ai = await getAIResponse(conv);
    conv.push({ role: "assistant", content: ai });
    log(`🤖 AI: ${ai}`);

    // 4. 返回回复 + 继续录音
    reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Zhiyu" language="zh-CN">${escapeXml(ai)}</Say>
  <Record
    action="${BASE_URL}/transcribe"
    method="POST"
    maxLength="8"
    timeout="5"
    playBeep="true"
    transcribe="false" />
  <Redirect>${BASE_URL}/voice</Redirect>
</Response>`);

  } catch (err) {
    log(`❌ 错误: ${err.message}`);
    reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Zhiyu" language="zh-CN">系统正忙，请稍后再试。</Say>
  <Hangup/>
</Response>`);
  }
});

try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  log(`✅ AI 语音客服启动 (${BASE_URL})`);
} catch(e) { console.error(e); process.exit(1); }
