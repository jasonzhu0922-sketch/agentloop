import { createServer } from "node:http";
import type { ModelInvocation } from "@zhujun/agentloop";
import { greetingModel } from "./models.ts";

/** Local protocol fixture, not a real model or third-party account acceptance. */
export async function fixtureProvider(beforeReply?: () => Promise<void>) {
  const calls: Array<{ path: string; authorization?: string; body: Record<string, unknown> }> = [];
  const model = greetingModel();
  const server = createServer((request, response) => { void (async () => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      calls.push({ path: request.url!, authorization: request.headers.authorization, body });
      await beforeReply?.();
      const chat = request.url === "/v1/chat/completions";
      const tools = (body.tools as Array<Record<string, unknown>> ?? []).map(item => {
        const tool = (chat ? item.function : item) as Record<string, unknown>;
        return { name: String(tool.name), description: String(tool.description ?? ""), inputSchema: tool.parameters as ModelInvocation["tools"][number]["inputSchema"] };
      });
      const reply = await model.complete({ tools, runId: "fixture", systemPrompt: "", phase: "planning", messages: [] });
      if (chat && body.stream !== true) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ id: "fixture", choices: [{ finish_reason: reply.finishReason, message: { role: "assistant", content: reply.content,
          ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) } }] }));
        return;
      }
      const output = reply.toolCalls.map((call, index) => ({ type: "function_call", id: `fc_${index}`, call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }));
      const payload = chat ? { id: "fixture", choices: [{ delta: { role: "assistant", content: reply.content,
        ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) }, finish_reason: reply.finishReason }] }
        : { type: "response.completed", response: { id: "fixture", status: "completed", output_text: reply.content, output } };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`data: ${JSON.stringify(payload)}\n\n${chat ? 'data: [DONE]\n\n' : ''}`);
    } catch { response.writeHead(500); response.end(); }
  })(); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture_bind_failed");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, calls,
    close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
