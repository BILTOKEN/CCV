// CCV3.0 API 中转代理 — 把任何 API 翻译成 Anthropic 格式
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = join(fileURLToPath(import.meta.url), '..');
const ROOT_DIR = join(__dirname, '..');
const ENV_FILE = join(ROOT_DIR, 'data', 'ai_settings.env');
const PORT = 3005;

// ═══════════════════════════════════════════════════════════
// 读配置（跟 server.mjs 一样）
// ═══════════════════════════════════════════════════════════
function readConfig() {
  if (!existsSync(ENV_FILE)) return {};
  const raw = readFileSync(ENV_FILE, 'utf-8');
  const config = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    config[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return config;
}

// ═══════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
  });
}

async function fetchExt(url, headers, body) {
  const mod = await import(url.startsWith('https') ? 'https' : 'http');
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method: 'POST', headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

function streamExt(url, headers, body, onChunk, onEnd) {
  return import(url.startsWith('https') ? 'https' : 'http').then(mod => new Promise((resolve, reject) => {
    const req = mod.request(url, { method: 'POST', headers }, res => {
      res.on('data', c => onChunk(c.toString()));
      res.on('end', () => { onEnd(); resolve(); });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  }));
}

function sendJSON(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, anthropic-beta'
  });
  res.end(JSON.stringify(obj));
}

function sendSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, anthropic-beta'
  });
}

function sseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ═══════════════════════════════════════════════════════════
// Anthropic → OpenAI 翻译
// ═══════════════════════════════════════════════════════════

// 转单个 content block
function blockToOpenAI(block) {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'image') {
    const src = block.source;
    const prefix = src.media_type ? `data:${src.media_type};base64,` : '';
    return { type: 'image_url', image_url: { url: prefix + src.data } };
  }
  if (block.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input || {}
    };
  }
  return block; // fallback
}

// 把 Anthropic 消息数组转成 OpenAI 格式
function messagesToOpenAI(anthropicMessages, system) {
  const result = [];
  if (system && system.trim()) {
    result.push({ role: 'system', content: system });
  }
  for (const msg of anthropicMessages) {
    if (msg.role === 'user') {
      const parts = [];
      const toolResults = []; // 独立的 tool 消息
      const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content || '' }];
      for (const block of content) {
        if (block.type === 'tool_result') {
          toolResults.push({
            role: 'tool',
            tool_call_id: block.tool_use_id || '',
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
          });
        } else {
          parts.push(blockToOpenAI(block));
        }
      }
      if (parts.length > 0 || toolResults.length === 0) {
        const textParts = parts.filter(p => p.type === 'text');
        const imgParts = parts.filter(p => p.type === 'image_url');
        if (imgParts.length > 0 && textParts.length === 0) {
          result.push({ role: 'user', content: imgParts.length === 1 && parts.length === 1 ? [imgParts[0]] : parts });
        } else if (parts.length === 1 && parts[0].type === 'text') {
          result.push({ role: 'user', content: parts[0].text });
        } else {
          result.push({ role: 'user', content: parts });
        }
      }
      // tool_result 消息追加在 user 消息后面
      for (const tr of toolResults) result.push(tr);
    } else if (msg.role === 'assistant') {
      const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content || '' }];
      let text = '';
      const toolCalls = [];
      for (const block of content) {
        if (block.type === 'text') text += (text ? '\n' : '') + block.text;
        else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input || {}) }
          });
        }
      }
      const entry = { role: 'assistant' };
      entry.content = text || null;
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      result.push(entry);
    }
  }
  return result;
}

// 转 tools 列表
function toolsToOpenAI(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description || '', parameters: t.input_schema || {} }
  }));
}

// finish_reason 映射
function mapFinish(reason) {
  const map = { 'stop': 'end_turn', 'tool_calls': 'tool_use', 'length': 'max_tokens' };
  return map[reason] || reason || null;
}

// OpenAI 响应 → Anthropic 格式
function openAIRespToAnthropic(openAIResp, model) {
  const choice = openAIResp.choices?.[0];
  if (!choice) return { type: 'message', role: 'assistant', content: [{ type: 'text', text: '' }], model, stop_reason: 'end_turn' };
  const content = [];
  if (choice.message?.content) content.push({ type: 'text', text: choice.message.content });
  for (const tc of (choice.message?.tool_calls || [])) {
    let args = tc.function?.arguments || {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name || '', input: args });
  }
  return {
    id: 'msg_' + (openAIResp.id || Date.now()),
    type: 'message', role: 'assistant', content,
    model, stop_reason: mapFinish(choice.finish_reason), stop_sequence: null,
    usage: { input_tokens: openAIResp.usage?.prompt_tokens || 0, output_tokens: openAIResp.usage?.completion_tokens || 0 }
  };
}

// ═══════════════════════════════════════════════════════════
// Anthropic → Gemini 翻译
// ═══════════════════════════════════════════════════════════

function messagesToGemini(anthropicMessages, system) {
  const contents = [];
  for (const msg of anthropicMessages) {
    if (msg.role === 'system') continue;
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts = [];
    const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content || '' }];
    for (const block of content) {
      if (block.type === 'text') parts.push({ text: block.text });
      else if (block.type === 'tool_use') parts.push({ functionCall: { name: block.name, args: block.input || {} } });
      else if (block.type === 'tool_result') {
        parts.push({
          functionResponse: {
            name: '', // Gemini 不需要 name 也能用
            response: { content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) }
          }
        });
      }
    }
    if (parts.length > 0) contents.push({ role, parts });
  }
  const result = { contents };
  if (system && system.trim()) result.systemInstruction = { parts: [{ text: system }] };
  return result;
}

function toolsToGemini(tools) {
  if (!tools || !tools.length) return undefined;
  return { functionDeclarations: tools.map(t => ({
    name: t.name, description: t.description || '',
    parameters: t.input_schema || { type: 'object', properties: {}, required: [] }
  })) };
}

function geminiRespToAnthropic(geminiResp, model) {
  const cand = geminiResp.candidates?.[0];
  if (!cand) return { type: 'message', role: 'assistant', content: [{ type: 'text', text: '' }], model, stop_reason: 'end_turn' };
  const content = [];
  for (const part of (cand.content?.parts || [])) {
    if (part.text !== undefined) content.push({ type: 'text', text: part.text });
    else if (part.functionCall) {
      content.push({
        type: 'tool_use',
        id: 'toolu_' + Date.now() + '_' + content.length,
        name: part.functionCall.name || '',
        input: part.functionCall.args || {}
      });
    }
  }
  const reasonMap = { 'STOP': 'end_turn', 'MAX_TOKENS': 'max_tokens' };
  return {
    id: 'msg_gemini_' + Date.now(),
    type: 'message', role: 'assistant', content,
    model, stop_reason: reasonMap[cand.finishReason] || null, stop_sequence: null,
    usage: {
      input_tokens: geminiResp.usageMetadata?.promptTokenCount || 0,
      output_tokens: geminiResp.usageMetadata?.candidatesTokenCount || 0
    }
  };
}

// ═══════════════════════════════════════════════════════════
// 非流式处理
// ═══════════════════════════════════════════════════════════

async function handleOpenAI(body, cfg) {
  const baseUrl = (cfg.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const apiKey = cfg.OPENAI_API_KEY || '';
  const model = body.model || cfg.OPENAI_MODEL || 'gpt-4o';
  const oaiBody = {
    model,
    messages: messagesToOpenAI(body.messages || [], body.system),
    stream: false
  };
  if (body.max_tokens) oaiBody.max_tokens = body.max_tokens;
  if (body.temperature != null) oaiBody.temperature = body.temperature;
  if (body.top_p != null) oaiBody.top_p = body.top_p;
  const tools = toolsToOpenAI(body.tools);
  if (tools) oaiBody.tools = tools;
  const r = await fetchExt(baseUrl + '/chat/completions', {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + apiKey
  }, JSON.stringify(oaiBody));
  if (r.status !== 200) throw new Error('Upstream error ' + r.status + ': ' + r.data);
  return openAIRespToAnthropic(JSON.parse(r.data), model);
}

async function handleGemini(body, cfg) {
  const apiKey = cfg.GEMINI_API_KEY || '';
  const model = body.model || cfg.AI_DISPLAY_MODEL || 'gemini-2.0-flash';
  const gBody = messagesToGemini(body.messages || [], body.system);
  const tools = toolsToGemini(body.tools);
  if (tools) gBody.tools = [tools];
  if (body.max_tokens) gBody.generationConfig = { ...(gBody.generationConfig || {}), maxOutputTokens: body.max_tokens };
  if (body.temperature != null) gBody.generationConfig = { ...(gBody.generationConfig || {}), temperature: body.temperature };
  const r = await fetchExt(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    { 'Content-Type': 'application/json' },
    JSON.stringify(gBody)
  );
  if (r.status !== 200) throw new Error('Upstream error ' + r.status + ': ' + r.data);
  return geminiRespToAnthropic(JSON.parse(r.data), model);
}

async function handleAnthropicPassthrough(body, cfg) {
  const apiKey = cfg.ANTHROPIC_API_KEY || '';
  const r = await fetchExt('https://api.anthropic.com/v1/messages', {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  }, JSON.stringify(body));
  if (r.status !== 200) throw new Error('Upstream error ' + r.status + ': ' + r.data);
  return JSON.parse(r.data); // 原样返回
}

// ═══════════════════════════════════════════════════════════
// 流式处理
// ═══════════════════════════════════════════════════════════

async function streamOpenAI(res, body, cfg) {
  const baseUrl = (cfg.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const apiKey = cfg.OPENAI_API_KEY || '';
  const model = body.model || cfg.OPENAI_MODEL || 'gpt-4o';
  const oaiBody = {
    model,
    messages: messagesToOpenAI(body.messages || [], body.system),
    stream: true
  };
  if (body.max_tokens) oaiBody.max_tokens = body.max_tokens;
  if (body.temperature != null) oaiBody.temperature = body.temperature;
  if (body.top_p != null) oaiBody.top_p = body.top_p;
  const tools = toolsToOpenAI(body.tools);
  if (tools) oaiBody.tools = tools;

  sendSSE(res);
  const msgId = 'msg_' + Date.now();
  let blockIdx = 0, textActive = false, msgStarted = false;
  let toolActive = false, currentToolId = '', currentToolName = '';

  await streamExt(baseUrl + '/chat/completions', {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + apiKey
  }, JSON.stringify(oaiBody), chunk => {
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') {
        if (textActive) { sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: blockIdx }); blockIdx++; textActive = false; }
        if (toolActive) { sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: blockIdx }); blockIdx++; toolActive = false; }
        sseEvent(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } });
        sseEvent(res, 'message_stop', { type: 'message_stop' });
        return;
      }
      try {
        const p = JSON.parse(raw);
        const delta = p.choices?.[0]?.delta;
        const finish = p.choices?.[0]?.finish_reason;
        if (!msgStarted) {
          sseEvent(res, 'message_start', {
            type: 'message_start',
            message: { id: p.id || msgId, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
          });
          msgStarted = true;
        }
        if (delta?.content !== undefined && delta.content !== null && delta.content !== '') {
          if (!textActive) {
            sseEvent(res, 'content_block_start', { type: 'content_block_start', index: blockIdx, content_block: { type: 'text', text: '' } });
            textActive = true;
          }
          sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: blockIdx, delta: { type: 'text_delta', text: delta.content } });
        }
        for (const tc of (delta?.tool_calls || [])) {
          if (tc.index !== undefined && tc.id) {
            if (textActive) { sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: blockIdx }); blockIdx++; textActive = false; }
            currentToolId = tc.id; currentToolName = tc.function?.name || '';
            sseEvent(res, 'content_block_start', { type: 'content_block_start', index: blockIdx, content_block: { type: 'tool_use', id: currentToolId, name: currentToolName, input: {} } });
            toolActive = true;
          }
          if (tc.function?.arguments && toolActive) {
            sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: blockIdx, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
          }
        }
        if (finish && finish !== 'stop' && finish !== 'tool_calls') {
          // 有些厂商在最后一条才发 finish_reason
        }
      } catch { /* 跳过解析失败的行 */ }
    }
  }, () => {});
  res.end();
}

async function streamGemini(res, body, cfg) {
  const apiKey = cfg.GEMINI_API_KEY || '';
  const model = body.model || cfg.AI_DISPLAY_MODEL || 'gemini-2.0-flash';
  const gBody = messagesToGemini(body.messages || [], body.system);
  const tools = toolsToGemini(body.tools);
  if (tools) gBody.tools = [tools];
  if (body.max_tokens) gBody.generationConfig = { ...(gBody.generationConfig || {}), maxOutputTokens: body.max_tokens };
  if (body.temperature != null) gBody.generationConfig = { ...(gBody.generationConfig || {}), temperature: body.temperature };

  sendSSE(res);
  const msgId = 'msg_gemini_' + Date.now();
  let blockIdx = 0, textActive = false, msgStarted = false;

  await streamExt(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`,
    { 'Content-Type': 'application/json' },
    JSON.stringify(gBody),
    chunk => {
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const p = JSON.parse(line.slice(6));
          const cand = p.candidates?.[0];
          if (!cand) continue;
          const parts = cand.content?.parts || [];
          if (!msgStarted) {
            sseEvent(res, 'message_start', { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
            msgStarted = true;
          }
          for (const part of parts) {
            if (part.text !== undefined) {
              if (!textActive) {
                sseEvent(res, 'content_block_start', { type: 'content_block_start', index: blockIdx, content_block: { type: 'text', text: '' } });
                textActive = true;
              }
              sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: blockIdx, delta: { type: 'text_delta', text: part.text } });
            }
          }
          if (cand.finishReason) {
            if (textActive) { sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: blockIdx }); blockIdx++; textActive = false; }
            const reasonMap = { 'STOP': 'end_turn', 'MAX_TOKENS': 'max_tokens' };
            sseEvent(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: reasonMap[cand.finishReason] || 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } });
            sseEvent(res, 'message_stop', { type: 'message_stop' });
          }
        } catch { /* skip */ }
      }
    }, () => {});
  res.end();
}

async function streamAnthropicPassthrough(res, body, cfg) {
  const apiKey = cfg.ANTHROPIC_API_KEY || '';
  sendSSE(res);
  await streamExt('https://api.anthropic.com/v1/messages', {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  }, JSON.stringify(body), chunk => res.write(chunk), () => {});
  res.end();
}

// ═══════════════════════════════════════════════════════════
// 路由处理
// ═══════════════════════════════════════════════════════════

function handleModels(res) {
  const cfg = readConfig();
  const model = cfg.AI_DISPLAY_MODEL || cfg.OPENAI_MODEL || 'deepseek-v4-flash';
  sendJSON(res, 200, {
    data: [{ id: model, object: 'model', created: Date.now(), owned_by: 'proxy' }]
  });
}

async function handleMessages(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJSON(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } }); }

  const cfg = readConfig();
  const provider = cfg.AI_PROVIDER || 'openai';
  const isStream = body.stream === true;

  try {
    if (provider === 'anthropic') {
      if (isStream) await streamAnthropicPassthrough(res, body, cfg);
      else sendJSON(res, 200, await handleAnthropicPassthrough(body, cfg));
    } else if (provider === 'gemini') {
      if (isStream) await streamGemini(res, body, cfg);
      else sendJSON(res, 200, await handleGemini(body, cfg));
    } else {
      // openai / deepseek / ollama / custom-openai ...
      if (isStream) await streamOpenAI(res, body, cfg);
      else sendJSON(res, 200, await handleOpenAI(body, cfg));
    }
  } catch (e) {
    console.error('[proxy] 上游错误:', e.message);
    if (!res.headersSent) {
      sendJSON(res, 502, { type: 'error', error: { type: 'api_error', message: e.message } });
    } else {
      // 流已开始，尝试发错误事件
      try { sseEvent(res, 'error', { type: 'error', error: { type: 'api_error', message: e.message } }); } catch {}
      res.end();
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 服务器启动
// ═══════════════════════════════════════════════════════════

createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost:' + PORT);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, anthropic-beta'
    });
    return res.end();
  }

  if (u.pathname === '/health' && req.method === 'GET') {
    return sendJSON(res, 200, { status: 'ok', provider: readConfig().AI_PROVIDER || 'unknown' });
  }

  if (u.pathname === '/v1/models' && req.method === 'GET') {
    return handleModels(res);
  }

  if (u.pathname === '/v1/messages' && req.method === 'POST') {
    return handleMessages(req, res);
  }

  sendJSON(res, 404, { type: 'error', error: { type: 'not_found', message: 'Not found' } });
}).listen(PORT, () => console.log(`[proxy] API 代理已启动，端口 ${PORT}`));
