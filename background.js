// Service worker: liga e desliga a captura das abas e mantém o selo "EQ" no ícone.
importScripts('eq.js');

const OFFSCREEN_URL = 'offscreen.html';

chrome.action.setBadgeBackgroundColor({ color: '#ff6a1a' });
chrome.action.setBadgeTextColor?.({ color: '#ffffff' });

// Criar e fechar o documento invisível acontece em fila, para um pedido não atropelar o outro.
let queue = Promise.resolve();
function serial(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'background') return;
  const handler = { start: startTab, stop: stopTab, stopAll, captures: syncTabs }[msg.type];
  if (!handler) return;
  handler(msg).then(
    () => sendResponse({ ok: true }),
    (err) => sendResponse({ ok: false, error: err?.message || String(err) }),
  );
  return true;
});

// Atalho de teclado: liga e desliga na aba da frente, sem abrir o popup.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const running = (await activeTabs()).includes(tab.id);
  try {
    if (running) await stopTab({ tabId: tab.id });
    else await startTab({ tabId: tab.id, settings: await settingsFor(tab) });
  } catch {
    // Sem popup aberto não há onde escrever o erro; o selo avisa por um instante.
    chrome.action.setBadgeText({ tabId: tab.id, text: '!' }).catch(() => {});
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => {}), 1500);
  }
});

function startTab({ tabId, settings }) {
  return serial(async () => {
    if ((await activeTabs()).includes(tabId)) return;
    await ensureOffscreen();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    if (!settings) ({ settings } = await chrome.storage.local.get('settings'));
    const res = await toOffscreen({ type: 'start', tabId, streamId, settings: EQ.sanitize(settings) });
    if (!res?.ok) throw new Error(res?.error || 'Não foi possível ligar o equalizador.');
    await syncTabs(res);
  });
}

async function stopTab({ tabId }) {
  if (!(await hasOffscreen())) return syncTabs({ tabIds: [] });
  const res = await toOffscreen({ type: 'stop', tabId });
  await syncTabs(res);
}

async function stopAll() {
  const list = await activeTabs();
  if (!list.length) return;
  if (!(await hasOffscreen())) return syncTabs({ tabIds: [] });
  let last = { tabIds: [] };
  for (const id of list) last = await toOffscreen({ type: 'stop', tabId: id });
  await syncTabs(last);
}

// O perfil do site, quando existe, também vale para o atalho de teclado.
async function settingsFor(tab) {
  const { settings, profiles } = await chrome.storage.local.get(['settings', 'profiles']);
  let host = '';
  try { host = new URL(tab.url).hostname.replace(/^www\./, ''); } catch { host = ''; }
  return EQ.sanitize((host && profiles?.[host]) || settings);
}

async function syncTabs({ tabIds = [] }) {
  const previous = await activeTabs();
  await chrome.storage.session.set({ activeTabs: tabIds });
  for (const id of previous) {
    if (!tabIds.includes(id)) chrome.action.setBadgeText({ tabId: id, text: '' }).catch(() => {});
  }
  tabIds.forEach(showBadge);
  if (!tabIds.length) serial(closeIfIdle);
}

function showBadge(tabId) {
  chrome.action.setBadgeText({ tabId, text: 'EQ' }).catch(() => {});
}

async function activeTabs() {
  const { activeTabs = [] } = await chrome.storage.session.get('activeTabs');
  return activeTabs;
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Aplicar o equalizador ao áudio capturado da aba.',
  });
}

async function closeIfIdle() {
  if ((await activeTabs()).length) return;
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
}

// O documento recém-criado pode levar alguns milissegundos para começar a ouvir mensagens.
async function toOffscreen(msg) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
    } catch (err) {
      if (attempt >= 20 || !/Receiving end does not exist/i.test(err?.message)) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  forgetSpeed(tabId);
  if (!(await activeTabs()).includes(tabId) || !(await hasOffscreen())) return;
  toOffscreen({ type: 'stop', tabId }).then(syncTabs).catch(() => {});
});

// O selo de uma aba pode sumir quando ela carrega outra página; recoloca.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === 'loading' && (await activeTabs()).includes(tabId)) showBadge(tabId);
});

// A velocidade é por aba: quando a aba fecha, o valor guardado não serve mais para ninguém.
async function forgetSpeed(tabId) {
  const { speeds } = await chrome.storage.session.get('speeds');
  if (!speeds || speeds[tabId] === undefined) return;
  delete speeds[tabId];
  await chrome.storage.session.set({ speeds });
}
