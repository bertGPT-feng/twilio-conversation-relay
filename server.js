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

const SYSTEM_PROMPT = `你是"法院通知中心"的 AI 语音客服，名叫小云。

## 重要规则
1. **永远用中文回复**
2. **回复极其简短，每次只说 1-2 句话**
3. **每句话结尾必须提一个问题**
4. 使用自然口语，像真人打电话一样
5. 不要说废话，不要重复已说过的信息
6. 如果用户说"转人工"或情绪激动，立即告知会安排转接

## 当前通话上下文
- 当事人：张伟
- 案号：(2026)京01民初123号
- 文书类型：民事判决书
- 登记地址：北京市朝阳区建国路88号`;

const sessions = new Map();

async function getAIResponse(conversation) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...conversation.slice(-10),
  ];
  const response = await openai.chat.completions.create({
    model: LLM_MODEL,
    messages,
    temperature: 0.6,
    max_tokens: 120,
  });
  return response.choices[0].message.content.trim();
}

const fastify = Fastify({ logger: false });
fastify.register(fastifyFormBody);

fastify.get("/health", async (req, reply) => reply.send({ ok: true, url: BASE_URL }));

// 测试端点 — 只放一段语音然后挂断
fastify.all("/test", async (req, reply) => {
  log(`📞 测试来电: ${req.body?.CallSid || "unknown"}`);
  reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.zh-CN-Wavenet-C" language="zh-CN">您好，这里是法院通知中心。我是小云。</Say>
  <Say voice="Google.zh-CN-Wavenet-C" language="zh-CN">请问您是张伟先生吗？请回答是或不是。</Say>
  <Gather input="speech dtmf" timeout="5" numDigits="1" speechTimeout="auto" language="zh-CN" action="${BASE_URL}/reply" method="POST" enhanced="true">
    <Say voice="Google.zh-CN-Wavenet-C" language="zh-CN">请回答。</Say>
  </Gather>
  <Say voice="Google.zh-CN-Wavenet-C" language="zh-CN">没有收到您的回复，再见。</Say>
</Response>`);
});

// 对话端点
fastify.all("/reply", async (req, reply) => {
  const callSid = req.body?.CallSid;
  const speech = req.body?.SpeechResult;
  const digits = req.body?.Digits;
  
  log(`📨 回复 (${callSid}): 语音="${speech}" DTMF="${digits}"`);

  if (!speech && !digits) {
    return reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.zh-CN-Wavenet-C">没听清楚，我们再说一次。</Say>
  <Redirect>${BASE_URL}/test</Redirect>
</Response>`);
  }

  const input = speech || `按键${digits}`;
  const conversation = sessions.get(callSid) || [];
  conversation.push({ role: "user", content: input });

  try {
    const ai = await getAIResponse(conversation);
    conversation.push({ role: "assistant", content: ai });
    log(`🤖 AI: ${ai}`);

    reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.zh-CN-Wavenet-C" language="zh-CN">${escapeXml(ai)}</Say>
  <Gather input="speech dtmf" timeout="5" speechTimeout="auto" language="zh-CN" action="${BASE_URL}/reply" method="POST" enhanced="true">
    <Say voice="Google.zh-CN-Wavenet-C">请讲。</Say>
  </Gather>
  <Redirect>${BASE_URL}/test</Redirect>
</Response>`);
  } catch (err) {
    log(`❌ LLM 错误: ${err.message}`);
    reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>系统繁忙，再见。</Say><Hangup/></Response>`);
  }
});

function escapeXml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}

try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  log(`✅ AI 语音客服启动 (${BASE_URL})`);
} catch(e) { console.error(e); process.exit(1); }
