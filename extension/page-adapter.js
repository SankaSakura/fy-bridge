// Serialized by chrome.scripting.executeScript into the selected fy page.
// All website cookies remain in the page. No token/cookie extraction is used.
export async function fyPage(action, input) {
  const slot = '__FY_BRIDGE_V1__';
  if (location.origin !== 'https://aifun.wiki'
    || !location.pathname.match(new RegExp('/explore/installed/' + input.appId + '/?$'))) {
    return { error: '请打开对应 FY 专用卡的对话页面。', restored: action !== 'run' };
  }
  if (action === 'cancel') {
    const pending = window[slot];
    if (pending?.id === input.id) pending.controller.abort();
    return { accepted: true };
  }
  const defaults = {
    pre_text: '', post_text: '', pre_prompt: ' ', sent_message_count: 0,
    world_book: [], regex_replaces: [], ai_summary_available: false,
    ai_summary: '', memory_palace: [], memory_type: 0,
    gen_conf: { auto_generate_enabled: false, roles: [] },
  };
  const project = (value, includeModel = false) => {
    const selected = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, value?.[key] ?? fallback]));
    if (includeModel) {
      const model = value?.model;
      if (!model || typeof model !== 'object' || Array.isArray(model)
        || typeof model.provider !== 'string' || !model.provider
        || typeof model.name !== 'string' || !model.name
        || !model.completion_params || typeof model.completion_params !== 'object'
        || Array.isArray(model.completion_params)) {
        throw new Error('FY 当前模型缺少可恢复的参数配置；请先在 FY 中选择模型并保存模型设置。');
      }
      selected.model = structuredClone(model);
    }
    return selected;
  };
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
  };
  const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  let targetConversationId = input.conversationId || null;
  let createdConversationId = null;
  function currentConversationId() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem('conversationIdInfo') || '{}'); }
    catch { throw new Error('无法读取 fy 当前会话，请先在网站选择一个已有对话。'); }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('fy 保存的当前会话映射格式不受支持，未发起生成。');
    const id = saved?.[input.appId];
    if (id == null || id === '') return null;
    if (typeof id !== 'string' || !id.trim() || id.length > 200) throw new Error('fy 保存的当前会话 ID 格式不受支持，未发起生成。');
    return id;
  }
  function requireCurrentConversation() {
    if (currentConversationId() !== targetConversationId) throw new Error('fy 当前会话已改变，未继续发送；请选好对话后重新请求。');
  }
  function requireResponseConversation(id) {
    if (!id) return;
    if (typeof id !== 'string' || !id.trim() || id.length > 200) throw new Error('fy 返回的会话 ID 格式不受支持。');
    if (targetConversationId && id !== targetConversationId) throw new Error('fy 返回的会话与目标会话不同；不会自动重发，请先查看网站已有结果。');
    if (!targetConversationId) {
      if (createdConversationId && id !== createdConversationId) throw new Error('fy 在一次请求中返回了不同的新会话 ID；不会自动重发。');
      createdConversationId = id;
    }
  }
  function requireCreatedConversation() {
    if (!targetConversationId && !createdConversationId) throw new Error('fy 已返回回复但没有新会话 ID，无法自动复用；请先在网站选择已有结果对应的对话，不要直接重发。');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(input.deadline || Date.now() + 20000, Date.now() + 1800000) - Date.now()));
  const headers = {
    'Content-Type': 'application/json', 'X-Language': 'zh-Hans',
    'X-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
  };
  let streamFailure = null;
  let trafficSequence = 0, exchangeSequence = 0, trafficUnavailable = false;
  async function recordTraffic(record) {
    if (!input.trafficChannel || trafficUnavailable) return;
    const sequence = ++trafficSequence;
    await new Promise(resolve => {
      const finish = error => {
        clearTimeout(timeout);
        window.removeEventListener('message', receive);
        if (error) {
          trafficUnavailable = true;
          console.error('FY traffic log unavailable:', error);
        }
        resolve();
      };
      const receive = event => {
        const value = event.data;
        if (event.source === window && event.origin === location.origin
          && value?.type === 'fy-bridge-traffic-ack' && value.channel === input.trafficChannel
          && value.sequence === sequence) finish(value.ok ? null : value.error || 'Log write failed.');
      };
      const timeout = setTimeout(() => finish('Log write timed out.'), 12000);
      window.addEventListener('message', receive);
      window.postMessage({ type: 'fy-bridge-traffic', channel: input.trafficChannel, sequence,
        record: { ...record, sequence, emittedAt: new Date().toISOString() } }, location.origin);
    });
  }
  function encodeBytes(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    }
    return btoa(binary);
  }
  async function read(response, exchangeId) {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = '', size = 0, chunkNumber = 0, complete = false, readError = null;
    try {
      while (reader) {
        const next = await reader.read();
        if (next.done) break;
        const byteOffset = size;
        size += next.value.byteLength;
        // Bound each relay message, not the recorded response. Base64 retains
        // exact bytes even when a UTF-8 character spans transport chunks.
        for (let offset = 0; offset < next.value.length; offset += 65536) {
          const bytes = next.value.subarray(offset, offset + 65536);
          const decoded = decoder.decode(bytes, { stream: true });
          text += decoded;
          await recordTraffic({ kind: 'response_chunk', exchangeId, chunkNumber: ++chunkNumber,
            byteOffset: byteOffset + offset, byteLength: bytes.length, text: decoded, base64: encodeBytes(bytes) });
        }
        if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('fy 回复超过 8 MiB。'); }
      }
      complete = true;
    } catch (error) {
      readError = String(error.message || error);
      throw error;
    } finally {
      const decoderTail = decoder.decode();
      text += decoderTail;
      await recordTraffic({ kind: 'response_end', exchangeId, complete, bytesReceived: size,
        chunks: chunkNumber, decoderTail, error: readError });
      reader?.releaseLock();
    }
    return text;
  }
  async function exchange(route, payload, signal = controller.signal) {
    const exchangeId = `${input.trafficChannel || input.id || action}:${++exchangeSequence}`;
    const method = payload === undefined ? 'GET' : 'POST';
    const requestBody = payload === undefined ? null : JSON.stringify(payload);
    await recordTraffic({ kind: 'request', exchangeId, method, url: '/go/api' + route, headers, body: requestBody });
    let response, text;
    try {
      response = await fetch('/go/api' + route, {
        method, credentials: 'include', redirect: 'error', cache: 'no-store', headers, signal,
        ...(requestBody === null ? {} : { body: requestBody }),
      });
      const responseHeaders = {};
      for (const name of ['content-type', 'content-length', 'content-encoding', 'date', 'x-request-id', 'request-id']) {
        const value = response.headers.get(name);
        if (value !== null) responseHeaders[name] = value;
      }
      await recordTraffic({ kind: 'response_headers', exchangeId, status: response.status,
        statusText: response.statusText, headers: responseHeaders });
      text = await read(response, exchangeId);
    } catch (error) {
      await recordTraffic({ kind: 'transport_error', exchangeId, error: String(error.message || error), aborted: signal.aborted });
      throw error;
    }
    // Read and record HTTP error bodies before reporting the existing error.
    if (!response.ok) throw new Error(`fy HTTP ${response.status}；请确认登录和专用卡权限。`);
    if (response.redirected) throw new Error('fy 请求被重定向；请重新登录。');
    return { response, text };
  }
  function unwrap(value) {
    if (value && Object.hasOwn(value, 'code')) {
      if (value.code !== 100000) throw new Error(`fy 返回错误码 ${String(value.code).slice(0, 80)}。`);
      return value.data;
    }
    return value;
  }
  async function api(route, payload, signal = controller.signal) {
    const { text } = await exchange(route, payload, signal);
    return unwrap(JSON.parse(text));
  }
  const conversationFields = () => targetConversationId ? { conversation_id: targetConversationId } : {};
  const getConfig = signal => api('/apps/config?app_id=' + encodeURIComponent(input.appId) + (targetConversationId ? '&conversation_id=' + encodeURIComponent(targetConversationId) : ''), undefined, signal);
  const setConfig = (config, signal) => api('/apps/config', { app_id: input.appId, ...conversationFields(), ...config }, signal);
  async function withGeneration(config) {
    const parameters = input.generation ?? {};
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('生成参数格式无效，未开始生成。');
    const entries = Object.entries(parameters);
    if (!entries.length) return config;
    const ranges = { max_tokens: 'max_token', temperature: 'temperature', top_p: 'top_p' };
    if (entries.some(([name]) => !Object.hasOwn(ranges, name))) throw new Error('此版本尚不支持请求中的生成参数，未开始生成。');
    const catalog = await api('/workspaces/model-list');
    if (!catalog || !Array.isArray(catalog.models)) throw new Error('FY 模型能力列表格式不受支持；无法确认生成参数，未开始生成。');
    const matches = catalog.models.filter(model => model.provider_name === config.model?.provider && model.model_id === config.model?.name);
    if (matches.length !== 1) throw new Error('无法唯一确认当前 FY 模型的参数能力，未开始生成。');
    for (const [name, value] of entries) {
      const range = matches[0].parameter_ranges?.[ranges[name]];
      if (!range || range.supported !== true) throw new Error(`当前 FY 模型不支持 ${name}；请更换模型或在客户端主动移除该参数。参数没有被忽略，未开始生成。`);
      if (typeof value !== 'number' || !Number.isFinite(value)
        || !Number.isFinite(range.min) || !Number.isFinite(range.max)
        || range.min > range.max || value < range.min || value > range.max
        || name === 'max_tokens' && !Number.isSafeInteger(value)) {
        throw new Error(`${name} 不在当前 FY 模型允许的范围 ${range.min}—${range.max} 内，未开始生成。`);
      }
    }
    return { ...config, model: { ...config.model, completion_params: { ...config.model.completion_params, ...parameters } } };
  }
  async function restore(original, expected, manual = false) {
    const cleanup = new AbortController();
    const cleanupTimer = setTimeout(() => cleanup.abort(), 20000);
    try {
      const current = project(await getConfig(cleanup.signal), Object.hasOwn(original, 'model'));
      if (equal(current, original)) return;
      if (!manual && !equal(current, expected)) throw new Error('专用卡配置在运行中发生变化，已停止自动恢复以保留人工修改。');
      await setConfig(original, cleanup.signal);
      if (!equal(project(await getConfig(cleanup.signal), Object.hasOwn(original, 'model')), original)) throw new Error('fy 未确认原配置恢复。');
    } finally { clearTimeout(cleanupTimer); }
  }
  function promptParts(value) {
    if (value == null) return [];
    const values = Array.isArray(value) ? value : [value];
    if (values.some(item => !item || typeof item.prompt !== 'string')) throw new Error('fy 调试提示词结构发生变化。');
    return values.map(item => item.prompt).filter(text => text.trim());
  }
  function inspectDebug(debug, system) {
    if (!debug || typeof debug !== 'object' || debug.real_memory_limit !== 0) throw new Error('fy 未确认记忆为 0，已阻止生成。');
    if (promptParts(debug.prefix_prompt).length || promptParts(debug.suffix_prompt).length) throw new Error('专用卡存在额外前后置词，已阻止生成。');
    const actual = promptParts(debug.system_prompt);
    const wanted = system.trim() ? [system] : [];
    if (!equal(actual, wanted)) throw new Error('系统提示词与本次输入不同，可能存在卡提示词、Mod 或其他附加内容；已阻止生成。');
  }
  async function generate(query) {
    requireCurrentConversation();
    // Context comes entirely from the client; debug must confirm memory 0.
    const { response, text } = await exchange('/apps/chat-messages', {
      app_id: input.appId, ...conversationFields(), inputs: {}, query, response_mode: 'blocking',
    });
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const data = unwrap(JSON.parse(text));
      if (!data || typeof data.answer !== 'string' || !data.answer.length || data.status >= 400 || data.error) throw new Error('FY 没有返回完整回复，请先在网站查看是否已有结果。');
      requireResponseConversation(data.conversation_id);
      requireCreatedConversation();
      const reason = data.finish_reason ?? data.metadata?.finish_reason ?? 'stop';
      if (!['stop', 'length', 'content_filter'].includes(reason)) throw new Error('fy 返回未知结束原因。');
      return { text: data.answer, finishReason: reason, conversationId: data.conversation_id || null };
    }
    // The website consumes data lines and completes on a normal stream EOF.
    // read() above must finish successfully; transport failures still reject.
    let answer = '', finishReason = 'stop', conversationId = null;
    function consume(raw, frameNumber, dataLine = null) {
      // Empty SSE data is a valid keepalive, not a JSON message. This also
      // applies to empty lines in the site's unseparated data-line format.
      if (!raw.trim() || raw.trim() === '[DONE]') return;
      let event;
      try { event = unwrap(JSON.parse(raw)); }
      catch (error) {
        if (error instanceof SyntaxError) {
          // Keep bounded evidence for this failed call; never return a partial
          // answer as a successful completion or submit another generation.
          streamFailure = {
            at: new Date().toISOString(), appId: input.appId,
            conversationId: conversationId || targetConversationId || createdConversationId,
            contentType: response.headers.get('content-type'), frameNumber, dataLine,
            streamCharacters: text.length, receivedAnswerCharacters: answer.length,
            partialAnswer: answer.slice(0, 65536), partialAnswerTruncated: answer.length > 65536,
            malformedData: raw.slice(0, 512), malformedDataTruncated: raw.length > 512,
          };
          throw new Error(answer.length
            ? 'fy 回复未能完整读取，已收到部分正文；请先在 FY 查看已有回复，不会自动重发。'
            : 'fy 回复流包含无法解析的数据；请先在 FY 查看已有回复，不会自动重发。');
        }
        throw error;
      }
      if (!event || typeof event !== 'object' || !event.event || event.event === 'error' || event.status >= 400 || event.error) throw new Error('fy 生成流返回错误或不支持的事件结构。');
      if (event.conversation_id) {
        requireResponseConversation(event.conversation_id);
        conversationId = event.conversation_id;
      }
      if (['message', 'agent_message', 'message_replace'].includes(event.event)) {
        if (typeof event.answer !== 'string') throw new Error('fy 回复片段格式无效。');
        answer = event.event === 'message_replace' ? event.answer : answer + event.answer;
      }
      if (event.event === 'message_end') {
        finishReason = event.finish_reason ?? event.metadata?.finish_reason ?? 'stop';
      }
    }
    let frameNumber = 0;
    for (const frame of text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n\n+/)) {
      frameNumber++;
      const lines = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart());
      if (!lines.length) continue;
      const raw = lines.join('\n');
      // Accept standard multiline SSE data as well as the site's independent
      // JSON data lines when there is no blank line between events.
      let combined = lines.length === 1 || raw.trim() === '[DONE]';
      if (!combined) {
        try { JSON.parse(raw); combined = true; } catch { /* Individual data lines below. */ }
      }
      if (combined) consume(raw, frameNumber);
      else for (const [index, line] of lines.entries()) consume(line, frameNumber, index + 1);
    }
    if (!answer.length) throw new Error('FY 没有返回回复正文。请先在网站查看是否已有结果，再决定是否重新提交。');
    if (!['stop', 'length', 'content_filter'].includes(finishReason)) throw new Error('fy 返回未知结束原因；不会自动重发。');
    requireCreatedConversation();
    return { text: answer, finishReason, conversationId };
  }
  let changed = false, expected, original, result = { restored: true };
  try {
    if (action === 'prepare') {
      if (window[slot]?.busy) throw new Error('专用卡已有桥接任务。');
      targetConversationId = currentConversationId();
      const config = await getConfig();
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('fy 配置结构发生变化。');
      requireCurrentConversation();
      return { generationProtocol: 1, original: project(config, !!input.generation && Object.keys(input.generation).length > 0), conversationId: targetConversationId, trafficLogIncomplete: trafficUnavailable };
    }
    if (action === 'recover') {
      if (window[slot]?.busy) throw new Error('页面上的原任务仍在生成或恢复，请等待结束后再恢复。');
      await restore(input.original, null, true);
      return { restored: true, trafficLogIncomplete: trafficUnavailable };
    }
    if (action !== 'run') throw new Error('未知桥接操作。');
    if (window[slot]?.busy) throw new Error('专用卡已有桥接任务。');
    if (Date.now() >= input.deadline) throw new Error('请求在发送前已超时。');
    requireCurrentConversation();
    original = input.original;
    if (!original || !equal(project(await getConfig(), Object.hasOwn(original, 'model')), original)) throw new Error('准备后专用卡配置发生变化，未发起生成。');
    expected = {
      ...original, pre_prompt: input.system, pre_text: '', post_text: '',
      sent_message_count: 0, world_book: [], regex_replaces: [],
      ai_summary_available: false, ai_summary: '', memory_palace: [], memory_type: 0,
      gen_conf: { ...original.gen_conf, auto_generate_enabled: false },
    };
    if (input.generation && Object.keys(input.generation).length) {
      if (!Object.hasOwn(original, 'model')) throw new Error('旧配置备份没有模型参数，未开始生成；请更新服务与扩展后重新提交。');
      expected = await withGeneration(expected);
      requireCurrentConversation();
      if (!equal(project(await getConfig(), true), original)) throw new Error('检查参数期间 FY 配置发生变化，未开始生成。');
    }
    window[slot] = { id: input.id, busy: true, controller };
    changed = true; // Even an interrupted POST can have changed server state.
    await setConfig(expected);
    if (!equal(project(await getConfig(), Object.hasOwn(original, 'model')), expected)) throw new Error('FY 未完整保存本次提示词或生成参数，已阻止生成；请先完成原配置恢复。');
    inspectDebug(await api('/apps/chat-debug', { app_id: input.appId, ...conversationFields(), inputs: {}, query: input.query, response_mode: 'blocking' }), input.system);
    result = { ...await generate(input.query), generationApplied: structuredClone(input.generation ?? {}), restored: false };
  } catch (error) {
    result = { error: controller.signal.aborted ? '任务取消或超时；已开始的生成可能扣费，不会自动重发。' : String(error.message || 'fy 操作失败'), restored: !changed };
    if (streamFailure) result.streamFailure = streamFailure;
  } finally {
    clearTimeout(timer);
    if (changed) {
      try { await restore(original, expected); result.restored = true; }
      catch { result.restored = false; result.error = (result.error ? result.error + ' ' : '') + '原配置未确认恢复，请在扩展设置页完成恢复。'; delete result.text; }
      if (window[slot]?.id === input.id) delete window[slot];
    }
  }
  if (createdConversationId) {
    result.conversationId = createdConversationId;
    try {
      // Use the same app -> conversation mapping written by the website's
      // normal conversation-completed handler. No React internals are used.
      const current = currentConversationId();
      if (current === null) {
        const saved = JSON.parse(localStorage.getItem('conversationIdInfo') || '{}');
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('会话映射格式无效');
        localStorage.setItem('conversationIdInfo', JSON.stringify({ ...saved, [input.appId]: createdConversationId }));
        if (currentConversationId() !== createdConversationId) throw new Error('会话 ID 未保存');
      }
    } catch {
      result.error = (result.error ? result.error + ' ' : '') + '新会话已创建但未能保存为当前会话，请在网站手动选择该对话后继续；不会自动重发。';
      delete result.text;
    }
  }
  if (trafficUnavailable) result.trafficLogIncomplete = true;
  return result;
}
