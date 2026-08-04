import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationRelayTwiml,
  identityResponseFor,
  localResponseFor,
  streamAIResponse,
  WELCOME_GREETING,
} from "./server.js";

test("TwiML enables fast turn detection and speech interruption", () => {
  const xml = conversationRelayTwiml("wss://relay.example.test/ws");
  assert.match(xml, /speechTimeout="900"/);
  assert.match(xml, /interruptible="speech"/);
  assert.match(xml, /reportInputDuringAgentSpeech="speech"/);
});

test("welcome greeting and affirmative identity reply advance without the LLM", () => {
  assert.match(WELCOME_GREETING, /先生/);
  const response = identityResponseFor("是的");
  assert.equal(response.confirmed, true);
  assert.doesNotMatch(response.text, /请问您是刘宗宝/);
  assert.match(response.text, /民事判决书/);
  assert.match(response.text, /送达流程吗？$/);
});

test("unclear identity reply asks once more without disclosing case details", () => {
  const response = identityResponseFor("喂，你说什么");
  assert.equal(response.confirmed, null);
  assert.match(response.text, /刘宗宝先生本人吗？$/);
  assert.doesNotMatch(response.text, /案号|判决书/);
});

test("common delivery intents are answered locally without the LLM", () => {
  assert.match(localResponseFor("方便"), /送达/);
  assert.match(localResponseFor("这是什么东西"), /民事判决书/);
  assert.match(localResponseFor("不需要了"), /再见。$/);
  assert.equal(localResponseFor("请解释一个复杂问题"), null);
});

test("generic acknowledgement uses the previous assistant question", () => {
  const deliveryContext = [
    {
      role: "assistant",
      content: "这是一份民事判决书的演示送达通知。请问您需要了解送达方式吗？",
    },
  ];
  assert.match(localResponseFor("好的", deliveryContext), /邮寄送达或电子送达/);
  assert.equal(localResponseFor("好的", []), null);
});

test("STT near-matches are accepted only in a matching conversation context", () => {
  const convenienceContext = [
    {
      role: "assistant",
      content: "请问您现在方便了解送达流程吗？",
    },
  ];
  assert.match(localResponseFor("旁边", convenienceContext), /演示送达通知/);
  assert.match(localResponseFor("我说方便", convenienceContext), /演示送达通知/);
  assert.equal(localResponseFor("旁边", []), null);

  const deliveryChoiceContext = [
    {
      role: "assistant",
      content: "请问您选择邮寄送达，还是电子送达？",
    },
  ];
  assert.match(localResponseFor("都不方便", deliveryChoiceContext), /官方渠道/);
});

test("scripted delivery questions stay local and within configured facts", () => {
  assert.match(localResponseFor("为什么要给我发这个"), /AI功能演示/);
  assert.match(localResponseFor("判决书有什么内容"), /无法提供具体内容/);
  assert.match(localResponseFor("不方便"), /官方渠道/);

  const deliveryContext = [
    {
      role: "assistant",
      content: "请问您需要了解送达方式吗？",
    },
  ];
  assert.match(localResponseFor("需要", deliveryContext), /邮寄送达或电子送达/);
});

test("emits a completed first sentence before the stream finishes", async () => {
  let releaseSecondChunk;
  const waitForSecondChunk = new Promise((resolve) => {
    releaseSecondChunk = resolve;
  });
  const openai = {
    chat: {
      completions: {
        create: async () => ({
          async *[Symbol.asyncIterator]() {
            yield { choices: [{ delta: { content: "好的。" } }] };
            await waitForSecondChunk;
            yield { choices: [{ delta: { content: "我来说明送达流程。" } }] };
          },
        }),
      },
    },
  };
  const tokens = [];
  const responsePromise = streamAIResponse(openai, [], async (token, last) =>
    tokens.push({ token, last }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(tokens, [{ token: "好的。", last: false }]);
  releaseSecondChunk();
  await responsePromise;
});

test("streams complete LLM sentences and marks only the final sentence", async () => {
  const openai = {
    chat: {
      completions: {
        create: async () => ({
          async *[Symbol.asyncIterator]() {
            yield { choices: [{ delta: { content: "您好，" } }] };
            yield { choices: [{ delta: { content: "刘先生。" } }] };
          },
        }),
      },
    },
  };
  const tokens = [];
  const answer = await streamAIResponse(
    openai,
    [{ role: "user", content: "是的" }],
    async (token, last) => tokens.push({ token, last }),
  );
  assert.equal(answer, "您好，刘先生。");
  assert.deepEqual(tokens, [
    { token: "您好，刘先生。", last: false },
    { token: "", last: true },
  ]);
});

test("replaces a long incomplete tail with a complete spoken fallback", async () => {
  const openai = {
    chat: {
      completions: {
        create: async () => ({
          async *[Symbol.asyncIterator]() {
            yield { choices: [{ delta: { content: "刘先生，具体内容请查看文书。" } }] };
            yield { choices: [{ delta: { content: "如有问题请联系您的" } }] };
            yield { choices: [{ delta: {}, finish_reason: "length" }] };
          },
        }),
      },
    },
  };
  const tokens = [];
  const answer = await streamAIResponse(openai, [], async (token, last) =>
    tokens.push({ token, last }),
  );
  assert.equal(
    answer,
    "刘先生，具体内容请查看文书。后续信息需要通过官方渠道确认。请问您需要我重新说明吗？",
  );
  assert.deepEqual(tokens, [
    { token: "刘先生，具体内容请查看文书。", last: false },
    {
      token: "后续信息需要通过官方渠道确认。请问您需要我重新说明吗？",
      last: true,
    },
  ]);
});

test("passes an AbortSignal to the streaming provider", async () => {
  const controller = new AbortController();
  let receivedSignal;
  const openai = {
    chat: {
      completions: {
        create: async (_body, options) => {
          receivedSignal = options.signal;
          return {
            async *[Symbol.asyncIterator]() {
              yield { choices: [{ delta: { content: "好" } }] };
            },
          };
        },
      },
    },
  };
  await streamAIResponse(openai, [], async () => {}, controller.signal);
  assert.equal(receivedSignal, controller.signal);
});
