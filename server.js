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
const callLogs = new Map(); // 记录请求详情

function escapeXml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}

async function getAIResponse(conv) {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...conv.slice(-10)];
  const r = await openai.chat.completions.create({ model: LLM_MODEL, messages, temperature: 0.6, max_tokens: 120 });
  return r.choices[0].message.content.trim();
}

const fastify = Fastify({ logger: false });
fastify.register(fastifyFormBody);

// 记录所有 POST 请求
fastify.addHook("onRequest", async (req, reply) => {
  if (req.method === "POST") {
    let body = "";
    try {
      if (req.body) body = JSON.stringify(req.body);
    } catch(e) {}
    log(`[${req.method}] ${req.url} body=${body.substring(0,200)}`);
  }
});

fastify.get("/health", async (req, reply) => reply.send({ ok: true, url: BASE_URL }));

// 主入口 — 先测试纯语音播放，看看呼叫是否能保持连接
fastify.all("/voice", async (req, reply) => {
  const cs = req.body?.CallSid || "?";
  log(`\n========== 来电: ${cs} ==========`);
  log(`完整请求: ${JSON.stringify(req.body || {})}`);
  sessions.set(cs, []);
  callLogs.set(cs, []);

  reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Zhiyu" language="zh-CN">您好，这里是法院通知中心，我是小云。</Say>
  <Say voice="Polly.Zhiyu" language="zh-CN">请问您是张伟先生吗？</Say>
  <Gather input="speech dtmf" timeout="5" numDigits="1" speechTimeout="auto" language="zh-CN" action="${BASE_URL}/gather" method="POST" enhanced="true">
    <Say voice="Polly.Zhiyu" language="zh-CN">如果是请说「是」或按1，如果不是请说「不是」或按2。</Say>
  </Gather>
  <Say voice="Polly.Zhiyu" language="zh-CN">没有收到回复，再见。</Say>
  <Hangup/>
</Response>`);
});

fastify.all("/gather", async (req, reply) => {
  const cs = req.body?.CallSid;
  const speech = req.body?.SpeechResult;
  const digits = req.body?.Digits;
  const confidence = req.body?.Confidence;
  
  log(`📨 回复 (${cs}): 语音="${speech}" 按键="${digits}" 置信度=${confidence}`);
  log(`完整回调: ${JSON.stringify(req.body || {})}`);

  if (!speech && !digits) {
    return reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Zhiyu" language="zh-CN">没听清楚，请再说一遍。</Say>
  <Redirect>${BASE_URL}/voice</Redirect>
</Response>`);
  }

  const conv = sessions.get(cs) || [];
  const userInput = speech || (digits === "1" ? "是" : digits === "2" ? "不是" : `按键${digits}`);
  conv.push({ role: "user", content: userInput });

  try {
    const ai = await getAIResponse(conv);
    conv.push({ role: "assistant", content: ai });
    log(`🤖 AI: ${ai}`);

    reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Zhiyu" language="zh-CN">${escapeXml(ai)}</Say>
  <Gather input="speech dtmf" timeout="5" speechTimeout="auto" language="zh-CN" action="${BASE_URL}/gather" method="POST" enhanced="true">
    <Say voice="Polly.Zhiyu" language="zh-CN">请讲。</Say>
  </Gather>
  <Redirect>${BASE_URL}/voice</Redirect>
</Response>`);
  } catch(err) {
    log(`❌ ${err.message}`);
    reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>系统繁忙，再见。</Say><Hangup/></Response>`);
  }
});

try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  log(`✅ ${BASE_URL}`);
} catch(e) { console.error(e); process.exit(1); }
