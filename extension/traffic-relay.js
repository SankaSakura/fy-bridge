// Runs in the isolated extension world. The page never receives bridge credentials.
export function fyTrafficRelay(channel, remove = false) {
  const slot = '__FY_TRAFFIC_RELAYS_V1__';
  const relays = globalThis[slot] ||= new Map();
  const previous = relays.get(channel);
  if (previous) window.removeEventListener('message', previous);
  relays.delete(channel);
  if (remove) return;
  const listener = event => {
    const value = event.data;
    if (event.source !== window || event.origin !== location.origin
      || value?.type !== 'fy-bridge-traffic' || value.channel !== channel) return;
    chrome.runtime.sendMessage({ action: 'traffic-record', channel, record: value.record })
      .then(result => window.postMessage({ type: 'fy-bridge-traffic-ack', channel, sequence: value.sequence, ...result }, location.origin))
      .catch(error => window.postMessage({ type: 'fy-bridge-traffic-ack', channel, sequence: value.sequence, ok: false, error: error.message }, location.origin));
  };
  relays.set(channel, listener);
  window.addEventListener('message', listener);
}
