import { BridgeError } from './protocol-error.mjs';

// These are FY's documented numeric completion fields, not client-specific rules.
export function generationParameters(body) {
  const result = {};
  for (const [name, min, max, integer] of [
    ['max_tokens', 1, Number.MAX_SAFE_INTEGER, true],
    ['temperature', 0, 2, false],
    ['top_p', 0, 1, false],
  ]) {
    const value = body[name];
    if (value == null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)
      || value < min || value > max || integer && !Number.isSafeInteger(value)) {
      throw new BridgeError(400, 'invalid_parameter', `${name} 必须是 ${min}—${max} 之间的${integer ? '整数' : '数字'}；实际模型范围会在生成前检查。`, name);
    }
    result[name] = value;
  }
  return result;
}
