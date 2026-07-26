import Fastify from "fastify";
import fastifyFormBody from "@fastify/formbody";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT || 8080;
const BASE_URL = process.env.DOMAIN 
  ? `https://${process.env.DOMAIN.replace(/^https?:\/\//, '')}`
  : `http://localhost:${PORT}`;
const LLM_MODEL = process.env.LLM_MODEL || "deepseek/deepseek-v4-flash";
const TWILIO_AUTH = Buffer.from(
  `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
).toString("base64");

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
  console.log(...args);
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

async function sttElevenLabs(audioUrl) {
  log(`⬇️ 下载录音: ${audioUrl}`);
  const resp = await fetch(audioUrl, { headers: { Authorization: `Basic ${TWILIO_AUTH}` }});
  if (!resp.ok) throw new Error(`下载失败: ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  log(`📦 大小: ${buf.length} bytes`);

  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "audio/wav" }), "rec.wav");
  fd.append("model_id", "scribe_v1");
  fd.append("language_code", "zh");

  const r2 = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    body: fd,
  });
  if (!r2.ok) throw new Error(`ElevenLabs ${r2.status}: ${await r2.text()}`);
  const json = await r2.json();
  log(`📝 转写: "${json.text}"`);
  return json.text || "";
}

const fastify = Fastify({ logger: false });
fastify.register(fastifyFormBody);

fastify.get("/health", async (req, reply) => reply.send({ ok: true }));

// 查看最近日志
fastify.get("/logs", async (req, reply) => {
  try {
    const lines = fs.readFileSync(LOG_FILE, "utf-8").split("\n").filter(Boolean).slice(-30);
    reply.type("text/plain").send(lines.join("\n"));
  } catch(e) {
    reply.send({ error: e.message });
  }
});

// 接听 → 问候 + 录音
fastify.all("/voice", async (req, reply) => {
  const cs = req.body?.CallSid || "?";
  log(`📞 来电: ${cs}`);
  sessions.set(cs, []);

  reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Zhiyu" language="zh-CN">您好，这里是法院通知中心，我是小云。</Say>
  <Say voice="Polly.Zhiyu" language="zh-CN">请问您是张伟先生吗？听到叮一声后请说话。</Say>
  <Record action="${BASE_URL}/transcribe" method="POST" maxLength="8" timeout="5" playBeep="true" transcribe="false" />
  <Redirect>${BASE_URL}/voice</Redirect>
</Response>`);
});

// 转写 + AI 回复
fastify.all("/transcribe", async (req, reply) => {
  const cs = req.body?.CallSid;
  const url = req.body?.RecordingUrl;

  log(`📨 录音: ${cs} ${url}`);

  if (!url) {
    return reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="Polly.Zhiyu">没听到，请再说一遍。</Say><Redirect>${BASE_URL}/voice</Redirect></Response>`);
  }

  try {
    const text = await sttElevenLabs(url);
    if (!text.trim()) {
      return reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="Polly.Zhiyu">没听清楚，请再说一遍。</Say><Redirect>${BASE_URL}/voice</Redirect></Response>`);
    }

    const conv = sessions.get(cs) || [];
    conv.push({ role: "user", content: text });

    const ai = await getAIResponse(conv);
    conv.push({ role: "assistant", content: ai });
    log(`🤖 AI: ${ai}`);

    reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Zhiyu" language="zh-CN">${escapeXml(ai)}</Say>
  <Record action="${BASE_URL}/transcribe" method="POST" maxLength="8" timeout="5" playBeep="true" transcribe="false" />
  <Redirect>${BASE_URL}/voice</Redirect>
</Response>`);
  } catch (err) {
    log(`❌ 错误: ${err.message} ${err.stack?.substring(0,200) || ""}`);
    reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="Polly.Zhiyu">系统正忙，请稍后再试。</Say><Hangup/></Response>`);
  }
});

try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  log(`✅ ${BASE_URL}`);
} catch(e) { console.error(e); process.exit(1); }
