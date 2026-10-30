/**
 * 局域网地址探测。
 *
 * 手机与电脑在同一 Wi-Fi 时，二维码里要放一个「手机能连通」的 IPv4。多网卡
 * （VMware / WSL / VPN / 虚拟网卡）会同时报出一堆地址，因此这里做择优排序：
 * 家用/办公网段优先，虚拟网卡垫底，并剔除回环与链路本地。
 */

import os from 'node:os';

/** 私有网段按「手机最可能连得上」的顺序打分，分数越小越优先。 */
function rank(address) {
  if (address.startsWith('192.168.')) return 0;
  if (address.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return 4; // CGNAT / Tailscale
  return 3;
}

/**
 * 列出本机可用于手机接入的 IPv4 地址（已排序去重）。
 * @returns {string[]} 例如 ["192.168.1.5", "10.0.0.7"]
 */
export function listLanIPv4() {
  const found = new Set();
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (!entry || entry.internal) continue;
      if (entry.family !== 'IPv4' && entry.family !== 4) continue;
      const address = entry.address;
      if (address.startsWith('127.') || address.startsWith('169.254.') || address === '0.0.0.0') continue;
      found.add(address);
    }
  }
  return [...found].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
