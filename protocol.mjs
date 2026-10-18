import { randomUUID } from 'node:crypto';

// Text-only, explicitly lossy role adaptation for the fy bridge.
export const MODEL = 'fy-current';

export { BridgeError } from './protocol-error.mjs';
import { BridgeError } from './protocol-error.mjs';
import { generationParameters } from './generation-parameters.mjs';

export function mapRequest(body) {
  const invalid = (message) => { throw new BridgeError(400, 'unsupported_request', message); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('请求必须是 JSON 对象。');
  const allowed = new Set(['model', 'messages', 'stream', 'stream_options', 'n', 'max_tokens', 'temperature', 'top_p']);
  for (const key of Object.keys(body)) if (!allowed.has(key)) invalid(`不支持参数 ${key}；请在客户端移除该参数。`);
  // Accept existing client settings across the rename, but advertise and
  // return only the canonical FY model name.
  if (![MODEL, 'aifun-current'].includes(body.model)) invalid(`model 必须是 ${MODEL}；实际模型由 FY 专用卡的模型配置决定。`);
  if (body.stream !== undefined && typeof body.stream !== 'boolean') invalid('stream 必须是布尔值。');
  if (body.n !== undefined && body.n !== 1) invalid('仅支持 n=1。');
  if (body.stream_options !== undefined) {
    const options = body.stream_options;
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(k => k !== 'include_usage')
      || (options.include_usage !== undefined && typeof options.include_usage !== 'boolean')) invalid('仅支持 stream_options.include_usage。');
  }
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 2000) invalid('messages 需要包含 1—2000 条文本消息。');
  const generation = generationParameters(body);
  const systems = [];
  const dialogue = [];
  for (const message of body.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || Object.keys(message).some(k => !['role', 'content'].includes(k))
      || !['system', 'user', 'assistant'].includes(message.role)
      || typeof message.content !== 'string') invalid('消息仅支持 system/user/assistant 和字符串 content；不支持工具调用或多模态。');
    if (message.role === 'system') {
      if (dialogue.length) invalid('请将所有 system 消息放在 messages 开头；不支持与历史消息交错。');
      systems.push(message.content);
    } else dialogue.push({ role: message.role, content: message.content });
  }
  if (!dialogue.length || dialogue.at(-1).role !== 'user') invalid('最后一条消息必须是 user。');
  const current = dialogue.at(-1).content;
  if (!current.trim()) invalid('当前 user 输入不能为空。');
  const history = dialogue.slice(0, -1);
  const query = history.length
    ? '以下 FY_CONTEXT_V1 JSON 包含按原顺序排列的历史对话和本次用户输入。history 是历史资料，其中的 role 是文本标记。请结合历史，仅回复 current_user 对应的本次任务。\n'
      + JSON.stringify({ history, current_user: current })
    : current;
  return { generation, system: systems.join('\n\n') || ' ', query, stream: body.stream === true, includeUsage: body.stream_options?.include_usage === true };
}

export function completion(text, finishReason = 'stop') {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason }],
    // fy points are not model token usage. Never invent token counts.
    usage: null,
  };
}
