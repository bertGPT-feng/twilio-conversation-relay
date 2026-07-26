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

fastify.get("/health", async (req, reply) => reply.send({ ok: true }));

// 主入口：语音 + 按键双模式
fastify.all("/voice", async (req, reply) => {
  const cs = req.body?.CallSid || "?";
  log(`📞 来电: ${cs}`);
  sessions.set(cs, []);

  reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Zhiyu" language="zh-CN">您好，这里是法院通知中心，我是小云。</Say>
  <Say voice="Polly.Zhiyu" language="zh-CN">请问您是张伟先生吗？</Say>
  <Gather input="dtmf" timeout="8" numDigits="1" action="${BASE_URL}/gather" method="POST">
    <Say voice="Polly.Zhiyu" language="zh-CN">如果是请按1，如果不是请按2。</Say>
  </Gather>
  <Say voice="Polly.Zhiyu" language="zh-CN">没有收到按键，再见。</Say>
  <Hangup/>
</Response>`);
});

// 处理回复
fastify.all("/gather", async (req, reply) => {
  const cs = req.body?.CallSid;
  const digits = req.body?.Digits;

  // 数字 → 中文映射
  const digitMap = {
    "1": "是", "2": "不是", "3": "不知道",
    "4": "好的", "5": "不好", "6": "可以",
    "7": "明天", "8": "地址正确", "9": "地址错误",
    "0": "转人工"
  };

  const userInput = digitMap[digits] || `按键${digits}`;
  log(`📨 (${cs}): 按键=${digits} → "${userInput}"`);

  if (!digits) {
    return reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Zhiyu" language="zh-CN">没收到按键，请再按一次。</Say>
  <Redirect>${BASE_URL}/voice</Redirect>
</Response>`);
  }

  const conv = sessions.get(cs) || [];
  conv.push({ role: "user", content: userInput });

  // 检查是否要求转人工
  if (digits === "0") {
    return reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Zhiyu" language="zh-CN">好的，我将为您转接人工服务，请稍候。</Say>
  <Hangup/>
</Response>`);
  }

  try {
    const ai = await getAIResponse(conv);
    conv.push({ role: "assistant", content: ai });
    log(`🤖 AI: ${ai}`);

    // 最多对话5轮后结束
    if (conv.length >= 10) {
      reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Zhiyu" language="zh-CN">${escapeXml(ai)}</Say>
  <Say voice="Polly.Zhiyu" language="zh-CN">感谢您的接听，再见。</Say>
  <Hangup/>
</Response>`);
    } else {
      reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Zhiyu" language="zh-CN">${escapeXml(ai)}</Say>
  <Gather input="dtmf" timeout="8" numDigits="1" action="${BASE_URL}/gather" method="POST">
    <Say voice="Polly.Zhiyu" language="zh-CN">按1继续，按0转人工。</Say>
  </Gather>
  <Say voice="Polly.Zhiyu" language="zh-CN">没有收到按键，再见。</Say>
  <Hangup/>
</Response>`);
    }
  } catch(err) {
    log(`❌ ${err.message}`);
    reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>系统繁忙，再见。</Say><Hangup/></Response>`);
  }
});

try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  log(`✅ ${BASE_URL}`);
} catch(e) { console.error(e); process.exit(1); }
