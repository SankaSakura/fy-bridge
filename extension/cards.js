export function serviceAddress(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
    || !['', '/'].includes(url.pathname) || url.search || url.hash
    || !Number.isInteger(Number(url.port)) || Number(url.port) < 1024) throw new Error('服务地址必须是 http://127.0.0.1:端口（1024—65535）。');
  return url.origin;
}
export function cardAddress(value) {
  const url = new URL(value.trim());
  const match = url.pathname.match(/^(?:\/[a-z]{2}(?:-[a-z]+)?)?\/explore\/installed\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i);
  if (url.origin !== 'https://aifun.wiki' || url.username || url.password || !match) throw new Error('请使用 fy 专用空白卡的对话预览页地址。');
  const appId = match[1].toLowerCase();
  return { appId, url: `https://aifun.wiki/zh/explore/installed/${appId}?preview=1` };
}
export async function listCardTabs() {
  const cards = [];
  for (const tab of await chrome.tabs.query({ url: 'https://aifun.wiki/*' })) {
    try { cards.push({ tab, card: cardAddress(tab.url) }); } catch { /* Other FY pages. */ }
  }
  return cards;
}
