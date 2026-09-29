// WebSocket client with auto-reconnect and server clock sync.
let ws = null, handler = () => {}, helloMsg = null, offset = 0, bestRtt = Infinity, closedByUs = false;
const queue = [];

export const serverNow = () => Date.now() + offset;

function open() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    if (helloMsg) ws.send(JSON.stringify(helloMsg));
    while (queue.length) ws.send(queue.shift());
    bestRtt = Infinity;
    for (let i = 0; i < 6; i++) setTimeout(() => send({ t: 'ping', c: Date.now() }), i * 150);
    handler({ t: 'net', up: true });
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'pong') {
      const now = Date.now(), rtt = now - m.c;
      if (rtt < bestRtt) { bestRtt = rtt; offset = m.s - (m.c + rtt / 2); }
      return;
    }
    handler(m);
  };
  ws.onclose = () => {
    handler({ t: 'net', up: false });
    if (!closedByUs) setTimeout(open, 1200);
  };
}

export function connect(hello, onMessage) {
  helloMsg = hello;
  handler = onMessage;
  open();
  // keep the clock estimate fresh
  setInterval(() => send({ t: 'ping', c: Date.now() }), 15000);
}
export function setHello(h) { helloMsg = h; }
export function send(msg) {
  const s = JSON.stringify(msg);
  if (ws && ws.readyState === 1) ws.send(s);
  else if (msg.t !== 'ping') queue.push(s);
}
