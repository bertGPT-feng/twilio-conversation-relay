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

const SYSTEM_PROMPT = `你是"法院通知中心"的 AI 语音客服，名叫小云。永远用中文回复，每次只说1-2句话并以问题结尾。`;

const sessions = new Map();

async function getAIResponse(conv) {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...conv.slice(-10)];
  const r = await openai.chat.completions.create({ model: LLM_MODEL, messages, temperature: 0.6, max_tokens: 120 });
  return r.choices[0].message.content.trim();
}

const fastify = Fastify({ logger: false });
fastify.register(fastifyFormBody);

fastify.get("/health", async (req, reply) => reply.send({ ok: true, url: BASE_URL }));

// 测试1: 只播放语音，不用语音识别
fastify.all("/voice", async (req, reply) => {
  const cs = req.body?.CallSid || "?";
  log(`📞 来电: ${cs}`);
  sessions.set(cs, []);

  reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.zh-CN-Wavenet-C" language="zh-CN">您好，这里是法院通知中心，我是小云。</Say>
  <Say voice="Google.zh-CN-Wavenet-C" language="zh-CN">请问您是张伟先生吗？</Say>
  <Gather input="speech" timeout="5" speechTimeout="auto" language="zh-CN" action="${BASE_URL}/gather" method="POST">
    <Say voice="Google.zh-CN-Wavenet-C">请回答。</Say>
  </Gather>
  <Say voice="Google.zh-CN-Wavenet-C">没有收到回复，再见。</Say>
  <Hangup/>
</Response>`);
});

fastify.all("/gather", async (req, reply) => {
  const cs = req.body?.CallSid;
  const speech = req.body?.SpeechResult;
  log(`🗣️ (${cs}): ${speech}`);

  if (!speech) {
    return reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Redirect>${BASE_URL}/voice</Redirect></Response>`);
  }

  const conv = sessions.get(cs) || [];
  conv.push({ role: "user", content: speech });

  try {
    const ai = await getAIResponse(conv);
    conv.push({ role: "assistant", content: ai });
    log(`🤖 AI: ${ai}`);

    // 如果是第一次回复，继续对话
    if (conv.length < 4) {
      reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.zh-CN-Wavenet-C" language="zh-CN">${escapeXml(ai)}</Say>
  <Gather input="speech" timeout="5" speechTimeout="auto" language="zh-CN" action="${BASE_URL}/gather" method="POST">
    <Say voice="Google.zh-CN-Wavenet-C">请讲。</Say>
  </Gather>
  <Redirect>${BASE_URL}/voice</Redirect>
</Response>`);
    } else {
      // 对话结束
      reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.zh-CN-Wavenet-C" language="zh-CN">${escapeXml(ai)}</Say>
  <Say voice="Google.zh-CN-Wavenet-C" language="zh-CN">感谢您的接听，稍后会有工作人员与您联系。再见。</Say>
  <Hangup/>
</Response>`);
    }
  } catch(err) {
    log(`❌ ${err.message}`);
    reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>系统繁忙，再见。</Say><Hangup/></Response>`);
  }
});

function escapeXml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}

try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  log(`✅ ${BASE_URL}`);
} catch(e) { console.error(e); process.exit(1); }
