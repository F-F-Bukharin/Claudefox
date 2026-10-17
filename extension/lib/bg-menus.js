// Right-click items that ask Claude about the selection, the page or a link. A click drafts the words into the text bar of
// the window it came from, unsent, and opens the sidebar; the panel takes the draft (takeDraft in panel-chat.js). A page or
// a link names its site for the next message (cfxSiteGate.addNext); a selection names none.
// The `if` is for the older test stubs, which have no menus API.
if (browser.menus) {
  const quoteLines = text => text.slice(0, 2000).split('\n').map(line => '> ' + line).join('\n');
  const about = (what, title, url) => 'About this ' + what + ': ' + (title ? title + ' (' + url + ')' : url) + '\n\n';
  const TITLES = { 'ask-selection': 'bg_menuSelection', 'ask-page': 'bg_menuPage', 'ask-link': 'bg_menuLink' };
  browser.menus.create({ id: 'ask-selection', title: t(TITLES['ask-selection']), contexts: ['selection'] });
  browser.menus.create({ id: 'ask-page', title: t(TITLES['ask-page']), contexts: ['page'] });
  browser.menus.create({ id: 'ask-link', title: t(TITLES['ask-link']), contexts: ['link'] });
  // The menu is built once, so a language change renames its items.
  cfxI18n.onChange(() => {
    if (!browser.menus.update) return;
    for (const id of Object.keys(TITLES)) { try { Promise.resolve(browser.menus.update(id, { title: t(TITLES[id]) })).catch(() => {}); } catch {} }
  });
  browser.menus.onClicked.addListener((info, tab) => {
    const pageUrl = String(tab.url || '');
    let text;
    if (info.menuItemId === 'ask-selection') {
      text = quoteLines(String(info.selectionText || '')) + '\n\n(from ' + (cfxSiteOf(pageUrl) || pageUrl) + ')\n\n';
    } else if (info.menuItemId === 'ask-page') {
      text = about('page', tab.title, pageUrl);
      cfxSiteGate.addNext(cfxSiteOf(pageUrl));
    } else if (info.menuItemId === 'ask-link') {
      text = about('link', info.linkText, String(info.linkUrl || ''));
      cfxSiteGate.addNext(cfxSiteOf(info.linkUrl));
    } else return;
    cfxState.set({ draft: { text, windowId: tab.windowId } });
    browser.sidebarAction.open();
  });
}
