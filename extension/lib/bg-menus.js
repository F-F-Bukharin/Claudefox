// Right-click items that ask Claude about the selection, the page or a link. A click drafts the words into the text bar of
// the window it came from, unsent, and opens the sidebar; the panel takes the draft (takeDraft in panel-chat.js). A page or
// a link names its site for the next message (cizSiteGate.addNext); a selection names none.
// The `if` is for the older test stubs, which have no menus API.
if (browser.menus) {
  const quoteLines = text => text.slice(0, 2000).split('\n').map(line => '> ' + line).join('\n');
  const about = (what, title, url) => 'About this ' + what + ': ' + (title ? title + ' (' + url + ')' : url) + '\n\n';
  browser.menus.create({ id: 'ask-selection', title: 'Ask Claude about this selection', contexts: ['selection'] });
  browser.menus.create({ id: 'ask-page', title: 'Ask Claude about this page', contexts: ['page'] });
  browser.menus.create({ id: 'ask-link', title: 'Ask Claude about this link', contexts: ['link'] });
  browser.menus.onClicked.addListener((info, tab) => {
    const pageUrl = String(tab.url || '');
    let text;
    if (info.menuItemId === 'ask-selection') {
      text = quoteLines(String(info.selectionText || '')) + '\n\n(from ' + (cizSiteOf(pageUrl) || pageUrl) + ')\n\n';
    } else if (info.menuItemId === 'ask-page') {
      text = about('page', tab.title, pageUrl);
      cizSiteGate.addNext(cizSiteOf(pageUrl));
    } else if (info.menuItemId === 'ask-link') {
      text = about('link', info.linkText, String(info.linkUrl || ''));
      cizSiteGate.addNext(cizSiteOf(info.linkUrl));
    } else return;
    cizState.set({ draft: { text, windowId: tab.windowId } });
    browser.sidebarAction.open();
  });
}
