'use strict';
// Sidebar panel, loaded last (see panel.html): connects to the background page, takes its messages and restores the saved chat. Every other panel file is loaded by the time this runs.

const port = browser.runtime.connect({ name: 'panel' });
const send = (type, extra) => port.postMessage(Object.assign({ type }, extra || {}));
// ------------------------------------------------------------ background link

port.onMessage.addListener(msg => {
  if (msg.type === 'state') { state = msg.state; render(msg.state, msg.log); maybeLoadMods(msg.state); }
  if (msg.type === 'callResult') {
    const done = pendingCalls.get(msg.id);
    if (done) { pendingCalls.delete(msg.id); done(msg); }
  }
  if (msg.type === 'chatEvent') onChatEvent(msg.id, msg.event || {});
  if (msg.type === 'chatDone') onChatDone(msg);
  if (msg.type === 'chatRuns') onChatRuns(msg.ids || []);
  if (msg.type === 'fileCreated') onFileCreated(msg.file || {});
  if (msg.type === 'snap') onSnap(msg);
  if (msg.type === 'toolResult') onToolResult(msg);
  if (msg.type === 'selfResult') onSelfResult(msg);
  if (msg.type === 'outputSaved') onOutputSaved(msg);
});

// Links in replies: web pages open in a new tab, zen://tab/<id> switches tab, zen://file/<id> opens a file.
function onLink(kind, value) {
  if (kind === 'tab') send('openTab', { id: Number(value) });
  else if (kind === 'file') send('openFile', { id: value });
  else send('openLink', { url: value });
}

function onFileCreated(f) {
  const m = chat.find(x => x.id === f.msg) || [...chat].reverse().find(x => x.role === 'assistant' && x.pending);
  if (!m) return;
  m.files = (m.files || []).filter(x => x.id !== f.id).concat([{ id: f.id, name: f.name, size: f.size, title: f.title || '' }]);
  saveChat();
  renderChat();
}

function call(tool, args) {
  return new Promise(resolve => {
    const id = callSeq++;
    pendingCalls.set(id, resolve);
    send('call', { id, tool, args: args || {} });
  });
}

// ------------------------------------------------------------ restore

(async () => {
  try {
    const got = await browser.storage.session.get(['chat', 'panelPage']);
    chat = Array.isArray(got.chat) ? got.chat : [];
    if (liveRuns) onChatRuns([...liveRuns]);
    renderChat();
    showPage(PAGES.includes(got.panelPage) ? got.panelPage : 'chat');
  } catch { renderChat(); showPage('chat'); }
})();

