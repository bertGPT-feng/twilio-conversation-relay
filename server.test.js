import assert from "node:assert/strict";
import test from "node:test";
import { buildServer, conversationRelayTwiml, SYSTEM_PROMPT } from "./server.js";

test("generates the low-latency Chinese ConversationRelay profile", () => {
  const xml = conversationRelayTwiml("wss://relay.example.test/ws");
  assert.match(xml, /url="wss:\/\/relay\.example\.test\/ws"/);
  assert.match(xml, /language="zh-CN"/);
  assert.match(xml, /transcriptionProvider="Deepgram"/);
  assert.match(xml, /speechModel="nova-2-general"/);
  assert.match(xml, /ttsProvider="Amazon"/);
  assert.match(xml, /voice="Zhiyu-Neural"/);
  assert.doesNotMatch(xml, /ElevenLabs/i);
});

test("system prompt preserves the configured role and safety boundaries", () => {
  assert.match(SYSTEM_PROMPT, /法院通知中心/);
  assert.match(SYSTEM_PROMPT, /以每次导入的联系人姓名为准/);
  assert.match(SYSTEM_PROMPT, /（2026）京01民初123号/);
  assert.match(SYSTEM_PROMPT, /不要求转账或付款/);
});

test("health identifies the active ConversationRelay mode", async () => {
  const app = buildServer({ openai: null });
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mode, "conversation-relay");
  await app.close();
});

test("dashboard route serves the Kangcheng Communications workspace", async () => {
  const app = buildServer({ openai: null });
  const response = await app.inject({ method: "GET", url: "/" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /^text\/html/);
  assert.match(response.body, /康城通讯/);
  assert.match(response.body, /导入联系人/);
  await app.close();
});

test("contact dialog can be dismissed without triggering required-field validation", async () => {
  const app = buildServer({ openai: null });
  const response = await app.inject({ method: "GET", url: "/" });
  assert.match(
    response.body,
    /class="icon-button" value="cancel" formnovalidate/,
  );
  assert.match(
    response.body,
    /class="secondary-button" value="cancel" formnovalidate>取消/,
  );
  await app.close();
});

test("successful manual contact creation explicitly closes its dialog", async () => {
  const app = buildServer({ openai: null });
  const response = await app.inject({ method: "GET", url: "/app.js" });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /event\.preventDefault\(\);[\s\S]*contactDialog\.close\(\);/);
  await app.close();
});

test("dashboard preserves a separately edited context for every template", async () => {
  const app = buildServer({ openai: null });
  const response = await app.inject({ method: "GET", url: "/app.js" });
  assert.equal(response.statusCode, 200);
  assert.match(
    response.body,
    /localStorage\.setItem\(contextStorageKey\(activeContextTemplate\), contextInput\.value\);/,
  );
  assert.match(
    response.body,
    /contextInput\.value = savedContextFor\(activeContextTemplate\);/,
  );
  assert.match(
    response.body,
    /localStorage\.setItem\("kangcheng-context-template", activeContextTemplate\);/,
  );
  await app.close();
});

test("production dashboard requires its management password", async () => {
  const app = buildServer({
    openai: null,
    twilioClient: null,
    dashboardUsername: "test-user",
    dashboardPassword: "test-dashboard-password",
    productionDashboard: true,
  });
  const denied = await app.inject({ method: "GET", url: "/api/session" });
  assert.equal(denied.statusCode, 401);

  const allowed = await app.inject({
    method: "GET",
    url: "/api/session",
    headers: {
      authorization: `Basic ${Buffer.from("test-user:test-dashboard-password").toString("base64")}`,
    },
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.json().ok, true);
  await app.close();
});

test("dashboard queue starts one Twilio call with dynamic contact context", async () => {
  let callOptions;
  let receivedSystemPrompt;
  let receivedUserPrompt;
  const calls = () => ({ update: async () => ({ status: "completed" }) });
  calls.create = async (options) => {
    callOptions = options;
    return { sid: "CA_QUEUE_TEST" };
  };
  const app = buildServer({
    openai: {
      chat: {
        completions: {
          create: async ({ messages }) => {
            receivedSystemPrompt = messages[0].content;
            receivedUserPrompt = messages.at(-1).content;
            return { choices: [{ message: { content: "这是本次授权回访。" } }] };
          },
        },
      },
    },
    twilioClient: { calls },
    twilioPhoneNumber: "+12565550100",
    dashboardUsername: "queue-user",
    dashboardPassword: "queue-password",
    productionDashboard: true,
    queueIntervalSeconds: 5,
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/queues",
    headers: {
      authorization: `Basic ${Buffer.from("queue-user:queue-password").toString("base64")}`,
    },
    payload: {
      contacts: [{ name: "测试联系人", phone: "+85589503303", note: "测试备注" }],
      context: "这是经过授权的康城通讯业务回访测试。",
      intervalSeconds: 5,
    },
  });
  assert.equal(response.statusCode, 201);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callOptions.to, "+85589503303");
  assert.equal(callOptions.from, "+12565550100");
  assert.deepEqual(callOptions.statusCallbackEvent, [
    "initiated",
    "ringing",
    "answered",
    "completed",
  ]);

  const voiceUrl = new URL(callOptions.url);
  const voice = await app.inject({
    method: "POST",
    url: `${voiceUrl.pathname}${voiceUrl.search}`,
  });
  assert.equal(voice.statusCode, 200);
  assert.match(voice.body, /康城通讯的AI语音助理/);
  assert.match(voice.body, /测试联系人/);
  assert.doesNotMatch(voice.body, /刘宗宝/);

  await app.ready();
  const socket = await app.injectWS(`/ws?token=${voiceUrl.searchParams.get("token")}`);
  socket.send(JSON.stringify({ type: "setup", callSid: "CA_DYNAMIC_CONTEXT" }));
  const identityMessage = new Promise((resolve) => socket.once("message", resolve));
  socket.send(JSON.stringify({ type: "prompt", voicePrompt: "是的", last: true }));
  assert.match(JSON.parse((await identityMessage).toString()).token, /测试联系人/);

  const llmResponse = new Promise((resolve) => socket.once("message", resolve));
  socket.send(JSON.stringify({ type: "prompt", voicePrompt: "方便", last: true }));
  const llmMessage = JSON.parse((await llmResponse).toString());
  assert.equal(llmMessage.token, "这是本次授权回访。");
  assert.equal(llmMessage.last, true);
  assert.match(receivedSystemPrompt, /经过授权的康城通讯业务回访测试/);
  assert.match(receivedSystemPrompt, /测试备注/);
  assert.equal(receivedUserPrompt, "方便");
  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.close();
  await closed;
  await app.close();
});

test("voice route returns ConversationRelay TwiML", async () => {
  const app = buildServer({
    openai: null,
    wsUrl: "wss://relay.example.test/ws",
    baseUrl: "https://relay.example.test",
  });
  const response = await app.inject({ method: "POST", url: "/voice" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /^text\/xml/);
  assert.match(response.body, /<ConversationRelay/);
  await app.close();
});

test("health exposes the active latency-optimized voice profile", async () => {
  const app = buildServer({ openai: null });
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.json().voiceProfile.speechModel, "nova-2-general");
  assert.equal(response.json().voiceProfile.speechTimeoutMs, 700);
  await app.close();
});

test("metrics endpoint reports streaming first-token latency", async () => {
  const app = buildServer({ openai: null });
  const response = await app.inject({ method: "GET", url: "/api/metrics" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().targetFirstTokenMs, 1200);
  assert.equal(response.json().samples, 0);
  await app.close();
});

test("ConversationRelay confirms identity before sending a complex prompt to the LLM", async () => {
  const openai = {
    chat: {
      completions: {
        create: async ({ messages }) => {
          assert.match(messages[0].content, /法院通知中心/);
          assert.equal(messages.at(-1).content, "请解释一个复杂问题");
          return { choices: [{ message: { content: "这是演示送达流程说明。" } }] };
        },
      },
    },
  };
  const app = buildServer({ openai });
  await app.ready();
  const socket = await app.injectWS("/ws");
  socket.send(JSON.stringify({ type: "setup", callSid: "CA_TEST" }));
  const identityResponse = new Promise((resolve) => socket.once("message", resolve));
  socket.send(JSON.stringify({ type: "prompt", voicePrompt: "是的", last: true }));
  const identityMessage = JSON.parse((await identityResponse).toString());
  assert.match(identityMessage.token, /民事判决书/);
  assert.equal(identityMessage.last, true);

  const llmResponse = new Promise((resolve) => socket.once("message", resolve));
  socket.send(
    JSON.stringify({
      type: "prompt",
      voicePrompt: "请解释一个复杂问题",
      last: true,
    }),
  );
  const llmMessage = JSON.parse((await llmResponse).toString());
  assert.deepEqual(llmMessage, {
    type: "text",
    token: "这是演示送达流程说明。",
    last: true,
    interruptible: true,
    preemptible: true,
  });
  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.close();
  await closed;
  await app.close();
});

test("welcome interruption without a final prompt receives an identity fallback", async () => {
  const app = buildServer({ openai: null, welcomeInterruptDelayMs: 5 });
  await app.ready();
  const socket = await app.injectWS("/ws");
  socket.send(JSON.stringify({ type: "setup", callSid: "CA_INTERRUPT_ONLY" }));

  const response = Promise.race([
    new Promise((resolve) => socket.once("message", resolve)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("identity fallback was not sent")), 100),
    ),
  ]);
  socket.send(
    JSON.stringify({
      type: "interrupt",
      utteranceUntilInterrupt: "您好，这里是",
      durationUntilInterruptMs: 900,
    }),
  );

  const message = JSON.parse((await response).toString());
  assert.match(message.token, /请问您是来电本人吗？$/);
  assert.equal(message.last, true);

  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.close();
  await closed;
  await app.close();
});

test("slow LLM receives a bounded fallback without an acknowledgement prefix", async () => {
  const openai = {
    chat: {
      completions: {
        create: async (_body, { signal }) => ({
          async *[Symbol.asyncIterator]() {
            await new Promise((_, reject) => {
              signal.addEventListener(
                "abort",
                () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
                { once: true },
              );
            });
          },
        }),
      },
    },
  };
  const app = buildServer({ openai, llmFirstTokenTimeoutMs: 10 });
  await app.ready();
  const socket = await app.injectWS("/ws");
  socket.send(JSON.stringify({ type: "setup", callSid: "CA_LLM_TIMEOUT" }));

  const identityResponse = new Promise((resolve) => socket.once("message", resolve));
  socket.send(JSON.stringify({ type: "prompt", voicePrompt: "是的", last: true }));
  await identityResponse;

  const messages = [];
  socket.on("message", (message) => messages.push(JSON.parse(message.toString())));
  socket.send(
    JSON.stringify({
      type: "prompt",
      voicePrompt: "请解释一个复杂问题",
      last: true,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.match(messages[0].token, /官方渠道/);
  assert.equal(messages[0].last, true);

  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.close();
  await closed;
  await app.close();
});
