import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "bridge-config.json");
const AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const LOG_PATH = path.join(__dirname, "bridge.log");

// Cache original Vertex model parts (including thoughtSignature) by call_id
const vertexCallPartCache = new Map();
// Map call_id -> function name for function_call_output turns
const callIdToFuncName = new Map();
// Cache auto-discovered Vertex project IDs per API key
const keyProjectCache = new Map();

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(LOG_PATH, line, "utf8");
  } catch {}
}

function loadConfig() {
  const defaults = {
    port: 18787,
    mode: "auto",
    default_model: "gemini-2.5-pro",
    vertex_api_version: "v1beta1",
    vertex_project_id: "",
    vertex_location: "global",
    vertex_fallback_model: "gemini-2.5-pro",
    openai_compat_base_url: "https://openrouter.ai/api/v1",
    api_key: ""
  };
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.render_base_url && !parsed.openai_compat_base_url) {
      parsed.openai_compat_base_url = parsed.render_base_url;
    }
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

function resolveApiKey(req, cfg) {
  if (cfg.api_key && cfg.api_key.trim()) {
    return cfg.api_key.trim();
  }
  try {
    const authJson = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
    const k = (authJson.OPENAI_API_KEY || "").trim();
    if (k) return k;
  } catch {}
  const authHeader = req.headers["authorization"] || "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  return "";
}

function sendSyntheticAssistantReply(res, text, model = "gemini-2.5-pro") {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  const respId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  const msgId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  sendSseEvent(res, { type: "response.created", response: { id: respId, status: "in_progress", output: [] } });
  sendSseEvent(res, { type: "response.in_progress", response: { id: respId, status: "in_progress", output: [] } });
  sendSseEvent(res, {
    type: "response.output_item.added",
    output_index: 0,
    item: { id: msgId, type: "message", status: "in_progress", role: "assistant", content: [] }
  });
  sendSseEvent(res, {
    type: "response.content_part.added",
    item_id: msgId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "" }
  });
  sendSseEvent(res, {
    type: "response.output_text.delta",
    item_id: msgId,
    output_index: 0,
    content_index: 0,
    delta: text
  });
  const completedMsg = {
    id: msgId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text }]
  };
  sendSseEvent(res, {
    type: "response.output_text.done",
    item_id: msgId,
    output_index: 0,
    content_index: 0,
    text
  });
  sendSseEvent(res, {
    type: "response.output_item.done",
    output_index: 0,
    item: completedMsg
  });
  sendSseEvent(res, {
    type: "response.completed",
    response: {
      id: respId,
      status: "completed",
      model,
      output: [completedMsg],
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 30
      }
    }
  });
  res.end();
}

function resolveTargetModel(requestedModel, cfg) {
  if (!requestedModel) return cfg.default_model || "gemini-2.5-pro";
  const m = String(requestedModel).trim();
  if (m.toLowerCase().startsWith("gpt-") || /^o\d/i.test(m)) {
    return cfg.default_model || "gemini-2.5-pro";
  }
  return m || cfg.default_model || "gemini-2.5-pro";
}

function sanitizeVertexSchema(schema) {
  if (!schema || typeof schema !== "object") {
    return { type: "OBJECT", properties: {} };
  }
  if (Array.isArray(schema)) {
    return schema.map(sanitizeVertexSchema);
  }
  const out = {};
  let nullable = false;

  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((t) => t !== "null");
    if (schema.type.includes("null")) nullable = true;
    out.type = (nonNull[0] || "string").toUpperCase();
  } else if (typeof schema.type === "string") {
    if (schema.type === "null") {
      out.type = "STRING";
      nullable = true;
    } else {
      out.type = schema.type.toUpperCase();
    }
  }

  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const variants = schema.anyOf || schema.oneOf;
    const nonNullVariants = variants.filter(
      (v) => !(v && (v.type === "null" || (Array.isArray(v.type) && v.type.length === 1 && v.type[0] === "null")))
    );
    if (nonNullVariants.length < variants.length) {
      nullable = true;
    }
    if (nonNullVariants.length === 1) {
      const merged = sanitizeVertexSchema(nonNullVariants[0]);
      Object.assign(out, merged);
    } else if (nonNullVariants.length > 1) {
      out.anyOf = nonNullVariants.map(sanitizeVertexSchema);
    }
  }

  if (nullable) {
    out.nullable = true;
  }
  if (typeof schema.description === "string") {
    out.description = schema.description;
  }
  if (Array.isArray(schema.enum)) {
    out.enum = schema.enum.filter((x) => x !== null).map(String);
    if (!out.type) out.type = "STRING";
  }
  if (schema.properties && typeof schema.properties === "object") {
    out.type = "OBJECT";
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      out.properties[k] = sanitizeVertexSchema(v);
    }
    if (Array.isArray(schema.required)) {
      const validReq = schema.required.filter((r) => r in out.properties);
      if (validReq.length > 0) out.required = validReq;
    }
  } else if (out.type === "OBJECT" && !out.properties) {
    out.properties = {};
  }
  if (schema.items) {
    out.type = "ARRAY";
    out.items = sanitizeVertexSchema(schema.items);
  } else if (out.type === "ARRAY" && !out.items) {
    out.items = { type: "STRING" };
  }
  if (!out.type && !out.anyOf) {
    out.type = "STRING";
  }
  return out;
}

function extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
    } else if (part && typeof part === "object") {
      if (typeof part.text === "string") {
        parts.push(part.text);
      } else if (typeof part.input_text === "string") {
        parts.push(part.input_text);
      } else if (typeof part.output_text === "string") {
        parts.push(part.output_text);
      }
    }
  }
  return parts.join("");
}

function buildVertexPayload(body) {
  const systemParts = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    systemParts.push({ text: body.instructions });
  }

  const rawTurns = [];
  const inputItems = Array.isArray(body.input)
    ? body.input
    : typeof body.input === "string"
      ? [{ type: "message", role: "user", content: body.input }]
      : [];

  for (const item of inputItems) {
    if (!item || typeof item !== "object") continue;
    const itemType = item.type || (item.role ? "message" : "");

    if (itemType === "message") {
      const role = item.role || "user";
      if (role === "system" || role === "developer") {
        const txt = extractTextFromContent(item.content);
        if (txt) systemParts.push({ text: txt });
        continue;
      }
      const vertexRole = role === "assistant" ? "model" : "user";
      const parts = [];
      if (typeof item.content === "string") {
        if (item.content) parts.push({ text: item.content });
      } else if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (!c) continue;
          if (typeof c === "string") {
            parts.push({ text: c });
          } else if (c.type === "input_text" || c.type === "output_text" || c.type === "text") {
            if (c.text) parts.push({ text: c.text });
          } else if (c.type === "input_image" && typeof c.image_url === "string") {
            const m = c.image_url.match(/^data:([^;]+);base64,(.+)$/);
            if (m) {
              parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
            }
          }
        }
      }
      if (parts.length > 0) {
        rawTurns.push({ role: vertexRole, parts });
      }
    } else if (itemType === "function_call") {
      const callId = item.call_id || item.id || `call_${crypto.randomUUID()}`;
      const name = item.name || "unknown_tool";
      callIdToFuncName.set(callId, name);
      let argsObj = {};
      if (typeof item.arguments === "string") {
        try {
          argsObj = JSON.parse(item.arguments);
        } catch {
          argsObj = { raw: item.arguments };
        }
      } else if (item.arguments && typeof item.arguments === "object") {
        argsObj = item.arguments;
      }
      const cachedPart = vertexCallPartCache.get(callId);
      const fcPart = cachedPart
        ? { ...cachedPart, functionCall: { name, args: argsObj } }
        : {
            functionCall: { name, args: argsObj },
            thoughtSignature: "skip_thought_signature_validator"
          };
      rawTurns.push({ role: "model", parts: [fcPart] });
    } else if (itemType === "function_call_output") {
      const callId = item.call_id || item.id || "";
      const name = callIdToFuncName.get(callId) || item.name || "tool";
      let outputStr = "";
      if (typeof item.output === "string") {
        outputStr = item.output;
      } else if (Array.isArray(item.output)) {
        outputStr = extractTextFromContent(item.output);
      } else if (item.output != null) {
        outputStr = JSON.stringify(item.output);
      }
      rawTurns.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name,
              response: { output: outputStr }
            }
          }
        ]
      });
    }
  }

  // Merge consecutive turns of the same role as required by Vertex Gemini
  const contents = [];
  for (const turn of rawTurns) {
    if (contents.length > 0 && contents[contents.length - 1].role === turn.role) {
      contents[contents.length - 1].parts.push(...turn.parts);
    } else {
      contents.push({ role: turn.role, parts: [...turn.parts] });
    }
  }
  if (contents.length === 0) {
    contents.push({ role: "user", parts: [{ text: "Hello" }] });
  }

  const vertexBody = { contents };
  if (systemParts.length > 0) {
    vertexBody.systemInstruction = {
      role: "system",
      parts: [{ text: systemParts.map((p) => p.text).join("\n\n") }]
    };
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const funcDecls = [];
    for (const t of body.tools) {
      if (!t || typeof t !== "object") continue;
      if (t.type === "function") {
        const fn = t.function || t;
        if (!fn.name) continue;
        funcDecls.push({
          name: fn.name,
          description: fn.description || "",
          parameters: sanitizeVertexSchema(fn.parameters)
        });
      }
    }
    if (funcDecls.length > 0) {
      vertexBody.tools = [{ functionDeclarations: funcDecls }];
    }
  }

  vertexBody.generationConfig = {
    temperature: typeof body.temperature === "number" ? body.temperature : 0.7
  };
  if (typeof body.max_output_tokens === "number") {
    vertexBody.generationConfig.maxOutputTokens = body.max_output_tokens;
  }

  return vertexBody;
}

function buildChatCompletionsPayload(body, targetModel) {
  const messages = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions });
  }

  const inputItems = Array.isArray(body.input)
    ? body.input
    : typeof body.input === "string"
      ? [{ type: "message", role: "user", content: body.input }]
      : [];

  for (const item of inputItems) {
    if (!item || typeof item !== "object") continue;
    const itemType = item.type || (item.role ? "message" : "");

    if (itemType === "message") {
      const role = item.role === "developer" ? "system" : item.role || "user";
      const txt = extractTextFromContent(item.content);
      messages.push({ role, content: txt });
    } else if (itemType === "function_call") {
      const callId = item.call_id || item.id || `call_${crypto.randomUUID()}`;
      const argsStr =
        typeof item.arguments === "string"
          ? item.arguments
          : JSON.stringify(item.arguments || {});
      const prev = messages[messages.length - 1];
      const tc = {
        id: callId,
        type: "function",
        function: { name: item.name || "tool", arguments: argsStr }
      };
      if (prev && prev.role === "assistant") {
        prev.tool_calls = prev.tool_calls || [];
        prev.tool_calls.push(tc);
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [tc] });
      }
    } else if (itemType === "function_call_output") {
      const callId = item.call_id || item.id || "";
      const outputStr =
        typeof item.output === "string"
          ? item.output
          : Array.isArray(item.output)
            ? extractTextFromContent(item.output)
            : JSON.stringify(item.output ?? "");
      messages.push({
        role: "tool",
        tool_call_id: callId,
        content: outputStr
      });
    }
  }

  const chatBody = {
    model: targetModel,
    messages: messages.length > 0 ? messages : [{ role: "user", content: "Hello" }],
    stream: true
  };

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const tools = [];
    for (const t of body.tools) {
      if (!t || typeof t !== "object") continue;
      if (t.type === "function") {
        const fn = t.function || t;
        if (!fn.name) continue;
        tools.push({
          type: "function",
          function: {
            name: fn.name,
            description: fn.description || "",
            parameters: fn.parameters || { type: "object", properties: {} }
          }
        });
      }
    }
    if (tools.length > 0) chatBody.tools = tools;
  }

  return chatBody;
}

function sendSseEvent(res, eventObj) {
  const type = eventObj.type;
  res.write(`event: ${type}\ndata: ${JSON.stringify(eventObj)}\n\n`);
}

function buildVertexStreamUrl(version, projectId, location, model, apiKey) {
  if (projectId) {
    const loc = location || "global";
    return `https://aiplatform.googleapis.com/${version}/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(loc)}/publishers/google/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  }
  return `https://aiplatform.googleapis.com/${version}/publishers/google/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
}

async function handleVertexStream(body, targetModel, apiKey, cfg, res) {
  const version = cfg.vertex_api_version || "v1beta1";
  let projectId = keyProjectCache.get(apiKey) || cfg.vertex_project_id || "";
  const location = cfg.vertex_location || "global";
  let activeModel = targetModel;
  const vertexPayload = buildVertexPayload(body);

  let url = buildVertexStreamUrl(version, projectId, location, activeModel, apiKey);
  logLine(`[Vertex] POST project=${projectId || "auto"} location=${location} model=${activeModel} (${version})`);
  let upstream = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(vertexPayload)
  });

  if (!upstream.ok) {
    let errText = await upstream.text();
    // Auto-extract project ID if Vertex error message contains projects/<number>
    const projMatch = errText.match(/projects\/(\d+)/);
    if (projMatch && projMatch[1] && projMatch[1] !== projectId) {
      projectId = projMatch[1];
      keyProjectCache.set(apiKey, projectId);
      url = buildVertexStreamUrl(version, projectId, location, activeModel, apiKey);
      logLine(`[Vertex Auto-Discovered Project=${projectId}] Retrying in locations/${location} model=${activeModel}`);
      upstream = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vertexPayload)
      });
      if (!upstream.ok) {
        errText = await upstream.text();
      }
    }

    // Fallback model if requested model is not found
    const fallbackModel = cfg.vertex_fallback_model || "gemini-2.5-pro";
    if (!upstream.ok && upstream.status === 404 && fallbackModel && fallbackModel !== activeModel) {
      logLine(`[Vertex 404 on ${activeModel}] Falling back to ${fallbackModel} in locations/${location}`);
      activeModel = fallbackModel;
      url = buildVertexStreamUrl(version, projectId, location, activeModel, apiKey);
      upstream = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vertexPayload)
      });
      if (!upstream.ok) {
        errText = await upstream.text();
      }
    }

    if (!upstream.ok) {
      logLine(`[Vertex Error] HTTP ${upstream.status}: ${errText.slice(0, 500)}`);
      res.writeHead(upstream.status, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: `Vertex API Error (${upstream.status}): ${errText}`,
            type: "invalid_request_error",
            code: String(upstream.status)
          }
        })
      );
      return;
    }
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  const respId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  const msgId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  sendSseEvent(res, { type: "response.created", response: { id: respId, status: "in_progress", output: [] } });
  sendSseEvent(res, { type: "response.in_progress", response: { id: respId, status: "in_progress", output: [] } });

  let msgStarted = false;
  let fullText = "";
  const outputItems = [];
  let inputTokens = 0;
  let outputTokens = 0;

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const processDataLine = (dataStr) => {
    if (!dataStr || dataStr === "[DONE]") return;
    let chunk;
    try {
      chunk = JSON.parse(dataStr);
    } catch {
      return;
    }
    if (chunk.usageMetadata) {
      inputTokens = chunk.usageMetadata.promptTokenCount || inputTokens;
      outputTokens = chunk.usageMetadata.candidatesTokenCount || outputTokens;
    }
    const candidates = chunk.candidates || [];
    for (const cand of candidates) {
      const parts = cand?.content?.parts || [];
      for (const part of parts) {
        if (part.thought === true && typeof part.text === "string") {
          continue;
        }
        if (typeof part.text === "string" && part.text.length > 0) {
          if (!msgStarted) {
            msgStarted = true;
            sendSseEvent(res, {
              type: "response.output_item.added",
              output_index: outputItems.length,
              item: { id: msgId, type: "message", status: "in_progress", role: "assistant", content: [] }
            });
            sendSseEvent(res, {
              type: "response.content_part.added",
              item_id: msgId,
              output_index: outputItems.length,
              content_index: 0,
              part: { type: "output_text", text: "" }
            });
          }
          fullText += part.text;
          sendSseEvent(res, {
            type: "response.output_text.delta",
            item_id: msgId,
            output_index: outputItems.length,
            content_index: 0,
            delta: part.text
          });
        } else if (part.functionCall) {
          if (msgStarted) {
            msgStarted = false;
            const completedMsg = {
              id: msgId,
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: fullText }]
            };
            sendSseEvent(res, {
              type: "response.output_text.done",
              item_id: msgId,
              output_index: outputItems.length,
              content_index: 0,
              text: fullText
            });
            sendSseEvent(res, {
              type: "response.output_item.done",
              output_index: outputItems.length,
              item: completedMsg
            });
            outputItems.push(completedMsg);
          }
          const callId = `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
          const fcId = `fc_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
          const fnName = part.functionCall.name || "tool";
          const fnArgs = JSON.stringify(part.functionCall.args || {});
          vertexCallPartCache.set(callId, part);
          callIdToFuncName.set(callId, fnName);

          const fcItem = {
            id: fcId,
            type: "function_call",
            status: "completed",
            call_id: callId,
            name: fnName,
            arguments: fnArgs
          };
          sendSseEvent(res, {
            type: "response.output_item.added",
            output_index: outputItems.length,
            item: { ...fcItem, arguments: "" }
          });
          sendSseEvent(res, {
            type: "response.output_item.done",
            output_index: outputItems.length,
            item: fcItem
          });
          outputItems.push(fcItem);
        }
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) {
        processDataLine(trimmed.slice(5).trim());
      }
    }
  }
  if (buffer.trim().startsWith("data:")) {
    processDataLine(buffer.trim().slice(5).trim());
  }

  if (msgStarted || outputItems.length === 0) {
    if (!msgStarted) {
      sendSseEvent(res, {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: msgId, type: "message", status: "in_progress", role: "assistant", content: [] }
      });
    }
    const completedMsg = {
      id: msgId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: fullText }]
    };
    sendSseEvent(res, {
      type: "response.output_text.done",
      item_id: msgId,
      output_index: outputItems.length,
      content_index: 0,
      text: fullText
    });
    sendSseEvent(res, {
      type: "response.output_item.done",
      output_index: outputItems.length,
      item: completedMsg
    });
    outputItems.push(completedMsg);
  }

  sendSseEvent(res, {
    type: "response.completed",
    response: {
      id: respId,
      status: "completed",
      model: activeModel,
      output: outputItems,
      usage: {
        input_tokens: inputTokens,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: outputTokens,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: inputTokens + outputTokens
      }
    }
  });
  res.end();
}

async function handleOpenAICompatChatStream(body, targetModel, apiKey, cfg, res) {
  const baseUrl = (cfg.openai_compat_base_url || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;
  const chatPayload = buildChatCompletionsPayload(body, targetModel);

  logLine(`[OpenAICompat] POST ${url} model=${targetModel}`);
  const upstream = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(chatPayload)
  });

  if (!upstream.ok) {
    const errText = await upstream.text();
    logLine(`[OpenAICompat Error] HTTP ${upstream.status}: ${errText.slice(0, 500)}`);
    res.writeHead(upstream.status, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: `Upstream API Error (${upstream.status}): ${errText}`,
          type: "invalid_request_error",
          code: String(upstream.status)
        }
      })
    );
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  const respId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  const msgId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  sendSseEvent(res, { type: "response.created", response: { id: respId, status: "in_progress", output: [] } });
  sendSseEvent(res, { type: "response.in_progress", response: { id: respId, status: "in_progress", output: [] } });

  let msgStarted = false;
  let fullText = "";
  const toolCallsByIndex = new Map();
  const outputItems = [];
  let inputTokens = 0;
  let outputTokens = 0;

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const processDataLine = (dataStr) => {
    if (!dataStr || dataStr === "[DONE]") return;
    let chunk;
    try {
      chunk = JSON.parse(dataStr);
    } catch {
      return;
    }
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens || inputTokens;
      outputTokens = chunk.usage.completion_tokens || outputTokens;
    }
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (!msgStarted) {
        msgStarted = true;
        sendSseEvent(res, {
          type: "response.output_item.added",
          output_index: 0,
          item: { id: msgId, type: "message", status: "in_progress", role: "assistant", content: [] }
        });
        sendSseEvent(res, {
          type: "response.content_part.added",
          item_id: msgId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "" }
        });
      }
      fullText += delta.content;
      sendSseEvent(res, {
        type: "response.output_text.delta",
        item_id: msgId,
        output_index: 0,
        content_index: 0,
        delta: delta.content
      });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCallsByIndex.has(idx)) {
          toolCallsByIndex.set(idx, {
            call_id: tc.id || `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
            name: tc.function?.name || "",
            arguments: tc.function?.arguments || ""
          });
        } else {
          const entry = toolCallsByIndex.get(idx);
          if (tc.id) entry.call_id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.arguments += tc.function.arguments;
        }
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) {
        processDataLine(trimmed.slice(5).trim());
      }
    }
  }
  if (buffer.trim().startsWith("data:")) {
    processDataLine(buffer.trim().slice(5).trim());
  }

  if (msgStarted || toolCallsByIndex.size === 0) {
    if (!msgStarted) {
      sendSseEvent(res, {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: msgId, type: "message", status: "in_progress", role: "assistant", content: [] }
      });
    }
    const completedMsg = {
      id: msgId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: fullText }]
    };
    sendSseEvent(res, {
      type: "response.output_text.done",
      item_id: msgId,
      output_index: 0,
      content_index: 0,
      text: fullText
    });
    sendSseEvent(res, {
      type: "response.output_item.done",
      output_index: 0,
      item: completedMsg
    });
    outputItems.push(completedMsg);
  }

  for (const [, tc] of toolCallsByIndex.entries()) {
    const fcItem = {
      id: `fc_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      type: "function_call",
      status: "completed",
      call_id: tc.call_id,
      name: tc.name || "tool",
      arguments: tc.arguments || "{}"
    };
    sendSseEvent(res, {
      type: "response.output_item.added",
      output_index: outputItems.length,
      item: { ...fcItem, arguments: "" }
    });
    sendSseEvent(res, {
      type: "response.output_item.done",
      output_index: outputItems.length,
      item: fcItem
    });
    outputItems.push(fcItem);
  }

  sendSseEvent(res, {
    type: "response.completed",
    response: {
      id: respId,
      status: "completed",
      model: targetModel,
      output: outputItems,
      usage: {
        input_tokens: inputTokens,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: outputTokens,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: inputTokens + outputTokens
      }
    }
  });
  res.end();
}

const initCfg = loadConfig();
const server = http.createServer(async (req, res) => {
  try {
    const cfg = loadConfig();
    const urlObj = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

    if (req.method === "GET" && (urlObj.pathname === "/v1/models" || urlObj.pathname === "/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: cfg.default_model || "gemini-2.5-pro", object: "model", owned_by: "local-bridge" },
            { id: "gemini-2.5-pro", object: "model", owned_by: "google-vertex" },
            { id: "gemini-2.5-flash", object: "model", owned_by: "google-vertex" },
            { id: "gemini-3.1-pro-preview", object: "model", owned_by: "google-vertex" }
          ]
        })
      );
      return;
    }

    if (req.method === "POST" && (urlObj.pathname === "/v1/responses" || urlObj.pathname === "/responses")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const body = rawBody ? JSON.parse(rawBody) : {};

      const apiKey = resolveApiKey(req, cfg);
      if (!apiKey) {
        sendSyntheticAssistantReply(
          res,
          "✅ **Local Responses API Bridge is connected!**\n\nNo API key was found. Please open `bridge-config.json` and fill in your `\"api_key\"` (takes effect immediately without restart)."
        );
        return;
      }

      const targetModel = resolveTargetModel(body.model, cfg);
      const isVertexKey = apiKey.startsWith("AQ.") || apiKey.startsWith("AIza");
      const useVertex = cfg.mode === "vertex" || (cfg.mode === "auto" && isVertexKey);

      if (useVertex) {
        await handleVertexStream(body, targetModel, apiKey, cfg, res);
      } else {
        await handleOpenAICompatChatStream(body, targetModel, apiKey, cfg, res);
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Not Found: ${urlObj.pathname}` } }));
  } catch (err) {
    logLine(`[Server Exception] ${err?.stack || err}`);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(err?.message || err) } }));
    } else {
      res.end();
    }
  }
});

// Reject WebSocket upgrades cleanly so Codex falls back to HTTP SSE
server.on("upgrade", (req, socket) => {
  socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  socket.destroy();
});

server.listen(initCfg.port || 18787, "127.0.0.1", () => {
  logLine(`Codex Responses Bridge listening on http://127.0.0.1:${initCfg.port || 18787}/v1`);
});
